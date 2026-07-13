import type { RepoRef } from './types';
import { debugError, debugLog } from './debug';

export interface BlobPageData {
  html: string | null;
  repoRef: RepoRef | null;
  isPrivate: boolean;
  source: 'code-view' | 'embedded' | 'url-fallback' | 'unavailable';
  diagnostic: string | null;
}

export interface PrFilesRoute {
  owner: string;
  repo: string;
  pullNumber: string;
}

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface RepositoryBytes {
  bytes: Uint8Array;
  contentType: string | null;
  authenticated: boolean;
}

export interface RepositoryFetchOptions {
  token?: string | null;
  privateRepo?: boolean;
  maxBytes?: number;
}

export function parseBlobUrl(url: string | URL): RepoRef | null {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const match = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i.exec(
    parsed.pathname,
  );
  if (!match) return null;

  return {
    owner: decodeSegment(match[1]),
    repo: decodeSegment(match[2]),
    ref: decodeSegment(match[3]),
    path: decodePath(match[4]),
  };
}

export function parsePrFilesUrl(url: string | URL): PrFilesRoute | null {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const match =
    /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:files|changes)\/?$/i.exec(
      parsed.pathname,
    );
  if (!match) return null;
  return {
    owner: decodeSegment(match[1]),
    repo: decodeSegment(match[2]),
    pullNumber: match[3],
  };
}

export function extractBlobPageData(): BlobPageData {
  const fallback = parseBlobUrl(location.href);
  const codeViewSource = extractCodeViewSource();
  const script = document.querySelector(
    'script[data-target="react-app.embeddedData"]',
  );
  if (!script?.textContent) {
    return {
      html: codeViewSource,
      repoRef: fallback,
      isPrivate: false,
      source: codeViewSource ? 'code-view' : fallback ? 'url-fallback' : 'unavailable',
      diagnostic: codeViewSource
        ? null
        : fallback
        ? 'GitHub embedded file data is not available yet; URL parsing cannot disambiguate refs containing slashes.'
        : 'GitHub embedded file data is unavailable.',
    };
  }

  try {
    const root = JSON.parse(script.textContent) as unknown;
    const payload = record(root)?.payload;
    const payloadRecord = record(payload);
    const fallbackRef = fallback;
    const repo = record(payloadRecord?.repo);
    const isPrivate =
      booleanValue(repo?.isPrivate) ?? booleanValue(repo?.private) ?? false;
    const refInfo = record(payloadRecord?.refInfo);
    const styledBlob = record(
      payloadRecord?.['codeViewBlobLayoutRoute.StyledBlob'],
    );
    const rawLines = styledBlob?.rawLines ?? payloadRecord?.rawLines;
    const embeddedHtml =
      Array.isArray(rawLines) && rawLines.every((line) => typeof line === 'string')
        ? rawLines.join('\n')
        : null;
    const html = codeViewSource ?? embeddedHtml;

    const owner = stringValue(repo?.ownerLogin) ?? fallbackRef?.owner;
    const repoName = stringValue(repo?.name) ?? fallbackRef?.repo;
    const ref =
      stringValue(refInfo?.currentOid) ??
      stringValue(payloadRecord?.currentOid) ??
      stringValue(refInfo?.name) ??
      fallbackRef?.ref;
    const embeddedPath =
      stringValue(payloadRecord?.path) ??
      stringValue(styledBlob?.path);
    const path =
      embeddedPath && pathMatchesLocation(embeddedPath)
        ? embeddedPath
        : fallbackRef?.path ?? embeddedPath;

    if (owner && repoName && ref && path) {
      const usedCanonicalPayload =
        typeof refInfo?.currentOid === 'string' ||
        typeof payloadRecord?.currentOid === 'string';
      return {
        html,
        repoRef: { owner, repo: repoName, ref, path },
        isPrivate,
        source: codeViewSource
          ? 'code-view'
          : usedCanonicalPayload
            ? 'embedded'
            : 'url-fallback',
        diagnostic: codeViewSource || usedCanonicalPayload
          ? null
          : 'Canonical commit SHA was absent from GitHub embedded data; preview uses route ref fallback.',
      };
    }

    return {
      html,
      repoRef: fallback,
      isPrivate,
      source: fallback ? 'url-fallback' : 'unavailable',
      diagnostic: fallback
        ? 'Canonical repository metadata was incomplete; preview uses route parsing fallback.'
        : 'Repository metadata could not be resolved.',
    };
  } catch (error) {
    console.error('[gh-html-preview] failed to parse embedded data:', error);
    return {
      html: codeViewSource,
      repoRef: fallback,
      isPrivate: false,
      source: codeViewSource ? 'code-view' : fallback ? 'url-fallback' : 'unavailable',
      diagnostic: codeViewSource
        ? null
        : fallback
        ? 'GitHub embedded data was malformed; preview uses route parsing fallback.'
        : 'GitHub embedded data was malformed.',
    };
  }
}

export function extractRawHtmlFromPage(): string | null {
  return extractBlobPageData().html;
}

export function buildRawUrl(repoRef: RepoRef): string {
  return `https://raw.githubusercontent.com/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(repoRef.repo)}/${encodeURIComponent(repoRef.ref)}/${encodePath(repoRef.path)}`;
}

export function buildJsdelivrUrl(
  repoRef: Pick<RepoRef, 'owner' | 'repo' | 'ref'>,
  assetPath: string,
): string {
  return `https://cdn.jsdelivr.net/gh/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(repoRef.repo)}@${encodeURIComponent(repoRef.ref)}/${encodePath(assetPath)}`;
}

export function buildContentsApiUrl(repoRef: RepoRef, path = repoRef.path): string {
  const apiPath = encodePath(path);
  const ref = encodeURIComponent(repoRef.ref);
  return `https://api.github.com/repos/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(repoRef.repo)}/contents/${apiPath}?ref=${ref}`;
}

export async function fetchRepositoryFile(
  repoRef: RepoRef,
  signal: AbortSignal,
  options: RepositoryFetchOptions = {},
): Promise<{ text: string; authenticated: boolean }> {
  const resource = await fetchRepositoryBytes(
    repoRef,
    repoRef.path,
    signal,
    options,
  );
  return {
    text: new TextDecoder().decode(resource.bytes),
    authenticated: resource.authenticated,
  };
}

export async function fetchRepositoryBytes(
  repoRef: RepoRef,
  path: string,
  signal: AbortSignal,
  options: RepositoryFetchOptions = {},
): Promise<RepositoryBytes> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (options.privateRepo && !options.token) {
    throw new Error('Private repository access requires a saved GitHub token.');
  }

  if (!options.privateRepo) {
    debugLog('github', 'fetch-public', {
      owner: repoRef.owner,
      repo: repoRef.repo,
      path,
    });
    const publicResponse = await fetch(buildRawUrl({ ...repoRef, path }), {
      signal,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    if (publicResponse.ok) {
      const resource = await readRepositoryResponse(
        publicResponse,
        maxBytes,
        signal,
        false,
      );
      debugLog('github', 'fetch-public-complete', {
        path,
        status: publicResponse.status,
        bytes: resource.bytes.byteLength,
      });
      return resource;
    }
    if (!options.token || ![401, 403, 404].includes(publicResponse.status)) {
      throw new Error(`Public raw file returned HTTP ${publicResponse.status}.`);
    }
  }

  debugLog('github', 'fetch-authenticated', {
    owner: repoRef.owner,
    repo: repoRef.repo,
    path,
    tokenConfigured: Boolean(options.token),
  });
  const response = await fetch(buildContentsApiUrl(repoRef, path), {
    signal,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: {
      Accept: 'application/vnd.github.raw+json',
      Authorization: `Bearer ${options.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const message =
      response.status === 401
        ? 'GitHub rejected the saved token. Replace an expired or invalid token in extension settings.'
        : response.status === 403
          ? 'GitHub denied repository access. Grant the saved token read-only Contents access to this repository.'
          : response.status === 404
            ? 'GitHub could not access this file. Confirm the token includes this repository and the file still exists.'
            : `GitHub private file API returned HTTP ${response.status}.`;
    const error = new Error(message);
    debugError('github', 'fetch-authenticated-failed', error, {
      path,
      status: response.status,
    });
    throw error;
  }
  const resource = await readRepositoryResponse(
    response,
    maxBytes,
    signal,
    true,
  );
  debugLog('github', 'fetch-authenticated-complete', {
    path,
    status: response.status,
    bytes: resource.bytes.byteLength,
  });
  return resource;
}

async function readRepositoryResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  authenticated: boolean,
): Promise<RepositoryBytes> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Repository resource exceeds ${maxBytes} byte limit.`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Repository resource exceeds ${maxBytes} byte limit.`);
    }
    return {
      bytes,
      contentType: response.headers.get('content-type'),
      authenticated,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error(`Repository resource exceeds ${maxBytes} byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes,
    contentType: response.headers.get('content-type'),
    authenticated,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function encodePath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

function decodePath(path: string): string {
  return path.split('/').map(decodeSegment).join('/');
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function extractCodeViewSource(): string | null {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="file content"]',
  );
  return textarea?.value || null;
}

function pathMatchesLocation(path: string): boolean {
  const encoded = path
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return location.pathname.endsWith(`/${encoded}`);
}
