import { buildJsdelivrUrl, fetchRepositoryBytes } from './github';
import { parse } from 'es-module-lexer/js';
import { debugError, debugLog } from './debug';
import type {
  RepoRef,
  ResolveDiagnostic,
  ResolveLimits,
  ResolveOptions,
  ResolveResult,
  ResourceStats,
} from './types';

const DEFAULT_LIMITS: ResolveLimits = {
  maxResourceBytes: 5 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  maxDepth: 4,
  concurrency: 6,
  maxOutputBytes: 40 * 1024 * 1024,
};

const MEDIA_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  css: 'text/css',
  gif: 'image/gif',
  ico: 'image/x-icon',
  htm: 'text/html',
  html: 'text/html',
  js: 'application/javascript',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  mjs: 'application/javascript',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  ogv: 'video/ogg',
  otf: 'font/otf',
  png: 'image/png',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  vtt: 'text/vtt',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

interface RepositoryUrl {
  kind: 'repo' | 'external' | 'data' | 'fragment' | 'invalid';
  value: string;
  path?: string;
  search?: string;
  hash?: string;
}

interface ResourceData {
  bytes: Uint8Array;
  mime: string;
}

class ResourceLoader {
  readonly diagnostics: ResolveDiagnostic[] = [];
  readonly stats: ResourceStats = {
    fetched: 0,
    inlined: 0,
    rewritten: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
    maxDepthReached: 0,
  };

  private readonly cache = new Map<string, Promise<ResourceData>>();
  private readonly waiters: Array<() => void> = [];
  private active = 0;

  constructor(
    readonly repoRef: RepoRef,
    readonly limits: ResolveLimits,
    readonly signal: AbortSignal,
    readonly privateRepo: boolean,
  ) {}

  addDiagnostic(
    code: string,
    message: string,
    url?: string,
    level: 'warning' | 'error' = 'warning',
  ): void {
    this.diagnostics.push({ level, code, message, ...(url ? { url } : {}) });
  }

  async load(path: string, search = ''): Promise<ResourceData> {
    const url = `${path}${search}`;
    const cached = this.cache.get(url);
    if (cached) return cached;

    const request = this.withSlot(async () => {
      this.signal.throwIfAborted();
      const resource = await fetchRepositoryBytes(
        this.repoRef,
        path,
        this.signal,
        {
          privateRepo: this.privateRepo,
          maxBytes: this.limits.maxResourceBytes,
        },
      );
      const bytes = resource.bytes;
      if (this.stats.bytes + bytes.byteLength > this.limits.maxTotalBytes) {
        throw new Error(`total resources exceed ${this.limits.maxTotalBytes} byte limit`);
      }

      this.stats.fetched += 1;
      this.stats.bytes += bytes.byteLength;
      const headerMime = resource.contentType?.split(';')[0].trim();
      return {
        bytes,
        mime: headerMime || mimeTypeFromPath(path),
      };
    });

    this.cache.set(url, request);
    return request;
  }

  private async withSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limits.concurrency) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.waiters.push(resolve);
      await promise;
    }
    this.signal.throwIfAborted();
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export async function resolveHtml(
  html: string,
  options: ResolveOptions,
): Promise<ResolveResult> {
  const startedAt = performance.now();
  options.signal?.throwIfAborted();
  const limits = validateLimits({ ...DEFAULT_LIMITS, ...options.limits });
  const signal = options.signal ?? new AbortController().signal;
  const loader = new ResourceLoader(
    options.repoRef,
    limits,
    signal,
    options.privateRepo ?? options.target === 'sandbox-private',
  );
  debugLog('resolver', 'start', {
    target: options.target,
    path: options.repoRef.path,
    privateRepo: loader.privateRepo,
    htmlBytes: new TextEncoder().encode(html).byteLength,
  });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const sourcePath = resolveBasePath(doc, options.repoRef, loader);

  if (options.target === 'sandbox') {
    await resolveSandboxDocument(doc, sourcePath, loader);
  } else {
    await resolvePrivateSandboxDocument(doc, sourcePath, loader);
  }

  options.signal?.throwIfAborted();
  const resolvedHtml = `<!doctype html>\n${doc.documentElement.outerHTML}`;
  const outputBytes = new TextEncoder().encode(resolvedHtml).byteLength;
  if (outputBytes > limits.maxOutputBytes) {
    throw new Error(
      `Resolved preview exceeds ${limits.maxOutputBytes} byte output limit.`,
    );
  }
  const result = {
    html: resolvedHtml,
    diagnostics: loader.diagnostics,
    resources: { ...loader.stats },
    performance: {
      resolveMs: performance.now() - startedAt,
      outputBytes,
    },
  };
  debugLog('resolver', 'complete', {
    target: options.target,
    path: options.repoRef.path,
    fetched: result.resources.fetched,
    inlined: result.resources.inlined,
    rewritten: result.resources.rewritten,
    skipped: result.resources.skipped,
    failed: result.resources.failed,
    bytes: result.resources.bytes,
    diagnostics: result.diagnostics.length,
    resolveMs: Math.round(result.performance.resolveMs),
    outputBytes,
  });
  return result;
}

export function resolveRepositoryUrl(
  input: string,
  repoRef: RepoRef,
  basePath = repoRef.path,
): RepositoryUrl {
  const value = input.trim();
  if (!value) return { kind: 'invalid', value };
  if (value.startsWith('#')) return { kind: 'fragment', value };
  if (/^data:/i.test(value)) return { kind: 'data', value };

  if (value.startsWith('//')) {
    return { kind: 'external', value: `https:${value}` };
  }

  let absolute: URL | null = null;
  try {
    absolute = new URL(value);
  } catch {
    absolute = null;
  }

  if (absolute) {
    const repoPath = repositoryPathFromAbsoluteUrl(absolute, repoRef);
    if (repoPath !== null) {
      return {
        kind: 'repo',
        value,
        path: repoPath,
        search: absolute.search,
        hash: absolute.hash,
      };
    }
    return { kind: 'external', value: absolute.href };
  }

  try {
    const base = new URL(
      `https://repository.invalid/${basePath.replace(/^\/+/, '')}`,
    );
    const resolved = new URL(value, base);
    return {
      kind: 'repo',
      value,
      path: decodeUrlPath(resolved.pathname.replace(/^\//, '')),
      search: resolved.search,
      hash: resolved.hash,
    };
  } catch {
    return { kind: 'invalid', value };
  }
}

async function resolveSandboxDocument(
  doc: Document,
  sourcePath: string,
  loader: ResourceLoader,
): Promise<void> {
  const existingBase = doc.querySelector('base');
  existingBase?.remove();
  const base = doc.createElement('base');
  const sourceDirectory = sourcePath.endsWith('/')
    ? sourcePath
    : sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
  base.href = buildJsdelivrUrl(loader.repoRef, sourceDirectory);
  const importMap = doc.createElement('script');
  importMap.type = 'importmap';
  importMap.textContent = JSON.stringify({
    imports: {
      'https://cdn.jsdelivr.net/': buildJsdelivrUrl(loader.repoRef, ''),
    },
  });
  doc.head.prepend(base, importMap);

  const stylesheetLinks = Array.from(
    doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'),
  );
  await Promise.all(
    stylesheetLinks.map(async (link) => {
      const href = link.getAttribute('href');
      if (!href) return;
      const resolved = resolveRepositoryUrl(href, loader.repoRef, sourcePath);
      if (resolved.kind !== 'repo' || !resolved.path) return;
      try {
        const resource = await loader.load(resolved.path, resolved.search);
        const css = await inlineRepositoryCss(
          new TextDecoder().decode(resource.bytes),
          resolved.path,
          1,
          loader,
        );
        link.href = resourceDataUrl(
          new TextEncoder().encode(css),
          'text/css',
        );
        loader.stats.inlined += 1;
      } catch (error) {
        link.remove();
        recordResourceFailure(loader, href, error);
      }
    }),
  );

  const moduleMap = await packageRepositoryScripts(doc, sourcePath, loader);
  importMap.textContent = JSON.stringify({
    imports: {
      'https://cdn.jsdelivr.net/': buildJsdelivrUrl(loader.repoRef, ''),
      ...moduleMap,
    },
  });

  const urlAttributes = [
    'href',
    'src',
    'poster',
    'data',
    'action',
    'formaction',
    'background',
    'cite',
    'longdesc',
    'manifest',
    'xlink:href',
  ];
  for (const attribute of urlAttributes) {
    for (const element of Array.from(doc.querySelectorAll(`[${cssAttribute(attribute)}]`))) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const resolved = resolveRepositoryUrl(value, loader.repoRef, sourcePath);
      if (resolved.kind === 'repo' && resolved.path !== undefined) {
        element.setAttribute(attribute, repositoryCdnUrl(resolved, loader.repoRef));
        loader.stats.rewritten += 1;
      } else if (resolved.kind === 'external') {
        element.setAttribute(attribute, resolved.value);
      }
    }
  }

  await Promise.all(
    Array.from(doc.querySelectorAll('img[srcset], source[srcset]')).map(
      async (element) => {
        const srcset = element.getAttribute('srcset');
        if (srcset === null) return;
        element.setAttribute(
          'srcset',
          await transformSrcset(srcset, async (url) => {
            const resolved = resolveRepositoryUrl(url, loader.repoRef, sourcePath);
            if (resolved.kind === 'repo' && resolved.path !== undefined) {
              loader.stats.rewritten += 1;
              return repositoryCdnUrl(resolved, loader.repoRef);
            }
            return resolved.kind === 'invalid' ? null : resolved.value;
          }),
        );
      },
    ),
  );

  for (const style of Array.from(doc.querySelectorAll('style'))) {
    style.textContent = await rewriteSandboxCss(
      style.textContent ?? '',
      sourcePath,
      loader,
    );
  }
  await Promise.all(
    Array.from(doc.querySelectorAll<HTMLElement>('[style]')).map(async (element) => {
      const css = element.getAttribute('style');
      if (css !== null) {
        element.setAttribute(
          'style',
          await rewriteCssUrls(css, sourcePath, loader),
        );
      }
    }),
  );
}

async function resolvePrivateSandboxDocument(
  doc: Document,
  sourcePath: string,
  loader: ResourceLoader,
): Promise<void> {
  doc.querySelector('base')?.remove();

  const stylesheetLinks = Array.from(
    doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'),
  );
  await Promise.all(
    stylesheetLinks.map(async (link) => {
      const href = link.getAttribute('href');
      if (!href) return;
      const resolved = resolveRepositoryUrl(href, loader.repoRef, sourcePath);
      if (resolved.kind !== 'repo' || !resolved.path) return;
      try {
        const resource = await loader.load(resolved.path, resolved.search);
        const css = await inlineRepositoryCss(new TextDecoder().decode(resource.bytes),
        resolved.path,
        1,
        loader,);
        link.href = resourceDataUrl(
          new TextEncoder().encode(css),
          'text/css',
        );
        loader.stats.inlined += 1;
      } catch (error) {
        link.remove();
        recordResourceFailure(loader, href, error);
      }
    }),
  );

  for (const style of Array.from(doc.querySelectorAll('style'))) {
    style.textContent = await inlineRepositoryCss(style.textContent ?? '',
    sourcePath,
    0,
    loader,);
  }
  await Promise.all(
    Array.from(doc.querySelectorAll<HTMLElement>('[style]')).map(
      async (element) => {
        const css = element.getAttribute('style');
        if (css !== null) {
          element.setAttribute(
            'style',
            await rewritePrivateCssUrls(css, sourcePath, loader),
          );
        }
      },
    ),
  );

  const attributeJobs: Array<Promise<void>> = [];
  const queueAttribute = (selector: string, attribute: string) => {
    for (const element of Array.from(doc.querySelectorAll(selector))) {
      attributeJobs.push(
        inlinePrivateAttribute(element, attribute, sourcePath, loader),
      );
    }
  };
  queueAttribute('img[src], input[type="image"][src]', 'src');
  queueAttribute('video[poster]', 'poster');
  queueAttribute('video[src], audio[src], source[src]', 'src');
  queueAttribute('track[src]', 'src');
  queueAttribute('[background]', 'background');
  queueAttribute('link[href]:not([rel~="stylesheet"])', 'href');
  queueAttribute('iframe[src], embed[src]', 'src');
  queueAttribute('object[data]', 'data');
  await Promise.all(attributeJobs);

  await Promise.all(
    Array.from(doc.querySelectorAll('img[srcset], source[srcset]')).map(
      async (element) => {
        const srcset = element.getAttribute('srcset');
        if (srcset === null) return;
        element.setAttribute(
          'srcset',
          await transformSrcset(srcset, async (url) =>
            privateResourceValue(url, sourcePath, loader),
          ),
        );
      },
    ),
  );

  rewritePreviewLinks(doc, sourcePath, loader.repoRef);
  const moduleMap = await packageRepositoryScripts(doc, sourcePath, loader);

  if (Object.keys(moduleMap).length > 0) {
    const importMap = doc.createElement('script');
    importMap.type = 'importmap';
    importMap.textContent = JSON.stringify({ imports: moduleMap });
    doc.head.prepend(importMap);
  }
}

function rewritePreviewLinks(
  doc: Document,
  sourcePath: string,
  repoRef: Readonly<RepoRef>,
): void {
  for (const link of Array.from(
    doc.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>(
      'a[href], area[href]',
    ),
  )) {
    const href = link.getAttribute('href');
    if (!href) continue;
    const resolved = resolveRepositoryUrl(href, repoRef, sourcePath);
    if (resolved.kind === 'fragment') continue;
    if (resolved.kind === 'repo' && resolved.path !== undefined) {
      const path = resolved.path
        .split('/')
        .map(encodeURIComponent)
        .join('/');
      link.href =
        `https://github.com/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(repoRef.repo)}` +
        `/blob/${encodeURIComponent(repoRef.ref)}/${path}${resolved.search ?? ''}${resolved.hash ?? ''}`;
    } else if (resolved.kind === 'external') {
      link.href = resolved.value;
    } else {
      link.removeAttribute('href');
      continue;
    }
    link.target = '_blank';
    link.rel = 'noreferrer';
  }
}

async function packageRepositoryScripts(
  doc: Document,
  sourcePath: string,
  loader: ResourceLoader,
): Promise<Record<string, string>> {
  const moduleMap: Record<string, string> = {};
  for (const script of Array.from(
    doc.querySelectorAll<HTMLScriptElement>('script[src]'),
  )) {
    const src = script.getAttribute('src');
    if (!src) continue;
    const resolved = resolveRepositoryUrl(src, loader.repoRef, sourcePath);
    if (resolved.kind !== 'repo' || !resolved.path) continue;
    try {
      if (script.type === 'module') {
        const graph = await buildPrivateModuleGraph(resolved.path, loader);
        Object.assign(moduleMap, graph.imports);
        script.src = graph.entry;
      } else {
        const resource = await loader.load(resolved.path, resolved.search);
        script.src = resourceDataUrl(
          resource.bytes,
          normalizedMime(resource.mime, resolved.path),
        );
      }
      loader.stats.inlined += 1;
    } catch (error) {
      script.remove();
      recordResourceFailure(loader, src, error);
    }
  }

  for (const script of Array.from(
    doc.querySelectorAll<HTMLScriptElement>('script[type="module"]:not([src])'),
  )) {
    try {
      script.textContent = await rewriteModuleSource(
        script.textContent ?? '',
        sourcePath,
        loader,
        moduleMap,
        new Map<string, string>(),
      );
    } catch (error) {
      loader.addDiagnostic(
        'inline-module-failed',
        error instanceof Error ? error.message : 'Inline module rewrite failed.',
        undefined,
        'error',
      );
    }
  }
  return moduleMap;
}

async function inlineRepositoryCss(
  css: string,
  sourcePath: string,
  depth: number,
  loader: ResourceLoader,
): Promise<string> {
  loader.stats.maxDepthReached = Math.max(loader.stats.maxDepthReached, depth);
  const importPattern =
    /@import\s+(?:url\(\s*(["']?)(.*?)\1\s*\)|(["'])(.*?)\3)\s*([^;]*);/gi;
  const imports = await replaceAsync(css, importPattern, async (match) => {
    const url = match[2] || match[4];
    const media = match[5]?.trim();
    const resolved = resolveRepositoryUrl(url, loader.repoRef, sourcePath);
    if (resolved.kind !== 'repo' || !resolved.path) return match[0];
    if (depth >= loader.limits.maxDepth) {
      loader.stats.skipped += 1;
      loader.addDiagnostic(
        'css-depth-limit',
        `CSS import exceeded depth limit ${loader.limits.maxDepth}.`,
        url,
      );
      return '';
    }
    try {
      const resource = await loader.load(resolved.path, resolved.search);
      const nested = await inlineRepositoryCss(new TextDecoder().decode(resource.bytes),
      resolved.path,
      depth + 1,
      loader,);
      loader.stats.inlined += 1;
      return media ? `@media ${media} {\n${nested}\n}` : nested;
    } catch (error) {
      recordResourceFailure(loader, url, error);
      return '';
    }
  });
  return rewritePrivateCssUrls(imports, sourcePath, loader);
}

async function rewritePrivateCssUrls(
  css: string,
  sourcePath: string,
  loader: ResourceLoader,
): Promise<string> {
  const urlPattern = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
  return replaceAsync(css, urlPattern, async (match) => {
    const url = match[2].trim();
    if (!url || url.startsWith('#')) return match[0];
    const value = await privateResourceValue(url, sourcePath, loader);
    return value ? `url("${value.replaceAll('"', '%22')}")` : 'url("")';
  });
}

async function inlinePrivateAttribute(
  element: Element,
  attribute: string,
  sourcePath: string,
  loader: ResourceLoader,
): Promise<void> {
  const value = element.getAttribute(attribute);
  if (!value) return;
  const inlined = await privateResourceValue(value, sourcePath, loader);
  if (inlined) element.setAttribute(attribute, inlined);
  else element.removeAttribute(attribute);
}

async function privateResourceValue(
  value: string,
  sourcePath: string,
  loader: ResourceLoader,
): Promise<string | null> {
  const resolved = resolveRepositoryUrl(value, loader.repoRef, sourcePath);
  if (
    resolved.kind === 'fragment' ||
    resolved.kind === 'data' ||
    resolved.kind === 'external'
  ) {
    return resolved.value;
  }
  if (resolved.kind !== 'repo' || !resolved.path) return null;
  try {
    const resource = await loader.load(resolved.path, resolved.search);
    loader.stats.inlined += 1;
    return resourceDataUrl(
      resource.bytes,
      normalizedMime(resource.mime, resolved.path),
    );
  } catch (error) {
    recordResourceFailure(loader, value, error);
    return null;
  }
}

interface PrivateModuleGraph {
  entry: string;
  imports: Record<string, string>;
}

async function buildPrivateModuleGraph(
  entryPath: string,
  loader: ResourceLoader,
): Promise<PrivateModuleGraph> {
  const imports: Record<string, string> = {};
  const modules = new Map<string, string>();
  await collectPrivateModule(entryPath, loader, imports, modules);
  return {
    entry: imports[privateModuleUrl(entryPath)],
    imports,
  };
}

async function collectPrivateModule(
  path: string,
  loader: ResourceLoader,
  imports: Record<string, string>,
  modules: Map<string, string>,
): Promise<void> {
  if (modules.has(path)) return;
  modules.set(path, '');
  const resource = await loader.load(path);
  const source = new TextDecoder().decode(resource.bytes);
  const transformed = await rewriteModuleSource(
    source,
    path,
    loader,
    imports,
    modules,
  );
  const dataUrl = resourceDataUrl(
    new TextEncoder().encode(transformed),
    'application/javascript',
  );
  modules.set(path, dataUrl);
  imports[privateModuleUrl(path)] = dataUrl;
  loader.stats.inlined += 1;
}

async function rewriteModuleSource(
  source: string,
  sourcePath: string,
  loader: ResourceLoader,
  imports: Record<string, string>,
  modules: Map<string, string>,
): Promise<string> {
  const [records] = parse(source);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const record of records) {
    if (!record.n) {
      if (record.d >= 0) {
        loader.addDiagnostic(
          'dynamic-module-expression',
          'Dynamic module expression could not be preloaded for private preview.',
          sourcePath,
        );
      }
      continue;
    }
    if (!isRepositoryModuleSpecifier(record.n)) continue;
    const resolved = resolveRepositoryUrl(record.n, loader.repoRef, sourcePath);
    if (resolved.kind !== 'repo' || !resolved.path) continue;
    const virtualUrl = privateModuleUrl(resolved.path);
    replacements.push({ start: record.s, end: record.e, value: virtualUrl });
    await collectPrivateModule(resolved.path, loader, imports, modules);
  }
  let transformed = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    transformed =
      transformed.slice(0, replacement.start) +
      replacement.value +
      transformed.slice(replacement.end);
  }
  return transformed;
}

function isRepositoryModuleSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    specifier.startsWith('http://') ||
    specifier.startsWith('https://') ||
    specifier.startsWith('//')
  );
}

function privateModuleUrl(path: string): string {
  return `https://private-preview.invalid/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

function resourceDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

async function rewriteSandboxCss(
  css: string,
  sourcePath: string,
  loader: ResourceLoader,
): Promise<string> {
  const importPattern =
    /@import\s+(?:url\(\s*(["']?)(.*?)\1\s*\)|(["'])(.*?)\3)\s*([^;]*);/gi;
  const importsRewritten = await replaceAsync(
    css,
    importPattern,
    async (match) => {
      const url = match[2] || match[4];
      const media = match[5]?.trim();
      const resolved = resolveRepositoryUrl(url, loader.repoRef, sourcePath);
      if (resolved.kind === 'repo' && resolved.path !== undefined) {
        loader.stats.rewritten += 1;
        const suffix = media ? ` ${media}` : '';
        return `@import url("${repositoryCdnUrl(resolved, loader.repoRef)}")${suffix};`;
      }
      if (resolved.kind === 'external') {
        const suffix = media ? ` ${media}` : '';
        return `@import url("${resolved.value.replaceAll('"', '%22')}")${suffix};`;
      }
      loader.stats.skipped += 1;
      loader.addDiagnostic(
        'sandbox-css-import-removed',
        'Executable preview removed invalid CSS import.',
        url,
      );
      return '';
    },
  );
  return rewriteCssUrls(importsRewritten, sourcePath, loader);
}

async function rewriteCssUrls(
  css: string,
  sourcePath: string,
  loader: ResourceLoader,
): Promise<string> {
  const urlPattern = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
  return replaceAsync(css, urlPattern, async (match) => {
    const url = match[2].trim();
    if (!url || url.startsWith('#')) return match[0];
    const resolved = resolveRepositoryUrl(url, loader.repoRef, sourcePath);
    if (resolved.kind === 'repo' && resolved.path !== undefined) {
      loader.stats.rewritten += 1;
      return `url("${repositoryCdnUrl(resolved, loader.repoRef)}")`;
    }
    if (resolved.kind === 'external') {
      return `url("${resolved.value.replaceAll('"', '%22')}")`;
    }
    return match[0];
  });
}

export async function transformSrcset(
  srcset: string,
  transform: (url: string) => Promise<string | null>,
): Promise<string> {
  const candidates = parseSrcset(srcset);
  const transformed = await Promise.all(
    candidates.map(async ({ url, descriptor }) => {
      const next = await transform(url);
      return next ? `${next}${descriptor ? ` ${descriptor}` : ''}` : null;
    }),
  );
  return transformed.filter((value): value is string => value !== null).join(', ');
}

function parseSrcset(srcset: string): Array<{ url: string; descriptor: string }> {
  const candidates: Array<{ url: string; descriptor: string }> = [];
  let position = 0;
  while (position < srcset.length) {
    while (position < srcset.length && /[\s,]/.test(srcset[position])) position += 1;
    if (position >= srcset.length) break;

    const urlStart = position;
    while (position < srcset.length && !/\s/.test(srcset[position])) position += 1;
    let url = srcset.slice(urlStart, position);
    let trailingCommas = 0;
    while (url.endsWith(',')) {
      url = url.slice(0, -1);
      trailingCommas += 1;
    }
    if (!url) continue;
    if (trailingCommas > 0) {
      candidates.push({ url, descriptor: '' });
      continue;
    }

    while (position < srcset.length && /\s/.test(srcset[position])) position += 1;
    const descriptorStart = position;
    let parentheses = 0;
    while (position < srcset.length) {
      const char = srcset[position];
      if (char === '(') parentheses += 1;
      else if (char === ')') parentheses = Math.max(0, parentheses - 1);
      else if (char === ',' && parentheses === 0) break;
      position += 1;
    }
    const descriptor = srcset.slice(descriptorStart, position).trim();
    if (position < srcset.length && srcset[position] === ',') position += 1;
    candidates.push({ url, descriptor });
  }
  return candidates;
}

function resolveBasePath(
  doc: Document,
  repoRef: RepoRef,
  loader: ResourceLoader,
): string {
  const href = doc.querySelector('base[href]')?.getAttribute('href');
  if (!href) return repoRef.path;
  const resolved = resolveRepositoryUrl(href, repoRef, repoRef.path);
  if (resolved.kind === 'repo' && resolved.path !== undefined) {
    return href.endsWith('/') && !resolved.path.endsWith('/')
      ? `${resolved.path}/`
      : resolved.path;
  }
  loader.addDiagnostic(
    'external-base-ignored',
    'External base URL cannot define repository resource paths.',
    href,
  );
  return repoRef.path;
}

function repositoryPathFromAbsoluteUrl(url: URL, repoRef: RepoRef): string | null {
  const owner = encodeURIComponent(repoRef.owner);
  const repo = encodeURIComponent(repoRef.repo);
  const ref = encodeURIComponent(repoRef.ref);
  const rawPrefix = `/${owner}/${repo}/${ref}/`;
  if (
    url.hostname === 'raw.githubusercontent.com' &&
    url.pathname.startsWith(rawPrefix)
  ) {
    return decodeUrlPath(url.pathname.slice(rawPrefix.length));
  }

  const cdnPrefix = `/gh/${owner}/${repo}@${ref}/`;
  if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith(cdnPrefix)) {
    return decodeUrlPath(url.pathname.slice(cdnPrefix.length));
  }

  const githubPrefix = `/${owner}/${repo}/`;
  if (url.hostname === 'github.com' && url.pathname.startsWith(githubPrefix)) {
    const remainder = url.pathname.slice(githubPrefix.length);
    for (const marker of ['blob/', 'raw/']) {
      const prefix = `${marker}${ref}/`;
      if (remainder.startsWith(prefix)) {
        return decodeUrlPath(remainder.slice(prefix.length));
      }
    }
  }
  return null;
}

function repositoryCdnUrl(resolved: RepositoryUrl, repoRef: RepoRef): string {
  return `${buildJsdelivrUrl(repoRef, resolved.path ?? '')}${resolved.search ?? ''}${resolved.hash ?? ''}`;
}

function normalizedMime(mime: string, path: string): string {
  const lower = mime.toLowerCase().split(';')[0].trim();
  const inferred = mimeTypeFromPath(path);
  if (
    (lower === 'application/octet-stream' || lower === 'text/plain') &&
    inferred !== 'application/octet-stream'
  ) {
    return inferred;
  }
  return lower;
}

function mimeTypeFromPath(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0];
  const extension = pathname.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_TYPES[extension] ?? 'application/octet-stream';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  const matches = Array.from(input.matchAll(pattern));
  if (matches.length === 0) return input;
  const replacements = await Promise.all(matches.map(replacer));
  let output = '';
  let cursor = 0;
  matches.forEach((match, index) => {
    const start = match.index ?? cursor;
    output += input.slice(cursor, start) + replacements[index];
    cursor = start + match[0].length;
  });
  return output + input.slice(cursor);
}

function recordResourceFailure(
  loader: ResourceLoader,
  url: string,
  error: unknown,
): void {
  if (error instanceof DOMException && error.name === 'AbortError') throw error;
  loader.stats.failed += 1;
  debugError('resolver', 'resource-failed', error, { path: url });
  loader.addDiagnostic(
    'resource-fetch-failed',
    error instanceof Error ? error.message : 'Resource fetch failed.',
    url,
    'error',
  );
}

function decodeUrlPath(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

function cssAttribute(attribute: string): string {
  return attribute.replace(':', '\\:');
}

function validateLimits(limits: ResolveLimits): ResolveLimits {
  if (
    limits.maxResourceBytes <= 0 ||
    limits.maxTotalBytes <= 0 ||
    limits.maxOutputBytes <= 0 ||
    limits.maxDepth < 0 ||
    limits.concurrency < 1
  ) {
    throw new Error('Resolve limits must be positive; maxDepth may be zero.');
  }
  return limits;
}


