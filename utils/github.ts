import type { RepoRef } from './types';

export interface BlobPageData {
  html: string | null;
  repoRef: RepoRef | null;
  source: 'embedded' | 'url-fallback' | 'unavailable';
  diagnostic: string | null;
}

export interface PrFilesRoute {
  owner: string;
  repo: string;
  pullNumber: string;
}

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

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
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/files\/?$/i.exec(
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
  const script = document.querySelector(
    'script[data-target="react-app.embeddedData"]',
  );
  if (!script?.textContent) {
    return {
      html: null,
      repoRef: fallback,
      source: fallback ? 'url-fallback' : 'unavailable',
      diagnostic: fallback
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
    const refInfo = record(payloadRecord?.refInfo);
    const styledBlob = record(
      payloadRecord?.['codeViewBlobLayoutRoute.StyledBlob'],
    );
    const rawLines = styledBlob?.rawLines ?? payloadRecord?.rawLines;
    const html =
      Array.isArray(rawLines) && rawLines.every((line) => typeof line === 'string')
        ? rawLines.join('\n')
        : null;

    const owner = stringValue(repo?.ownerLogin) ?? fallbackRef?.owner;
    const repoName = stringValue(repo?.name) ?? fallbackRef?.repo;
    const ref =
      stringValue(refInfo?.currentOid) ??
      stringValue(payloadRecord?.currentOid) ??
      stringValue(refInfo?.name) ??
      fallbackRef?.ref;
    const path =
      stringValue(payloadRecord?.path) ??
      stringValue(styledBlob?.path) ??
      fallbackRef?.path;

    if (owner && repoName && ref && path) {
      const usedCanonicalPayload =
        typeof refInfo?.currentOid === 'string' ||
        typeof payloadRecord?.currentOid === 'string';
      return {
        html,
        repoRef: { owner, repo: repoName, ref, path },
        source: usedCanonicalPayload ? 'embedded' : 'url-fallback',
        diagnostic: usedCanonicalPayload
          ? null
          : 'Canonical commit SHA was absent from GitHub embedded data; preview uses route ref fallback.',
      };
    }

    return {
      html,
      repoRef: fallback,
      source: fallback ? 'url-fallback' : 'unavailable',
      diagnostic: fallback
        ? 'Canonical repository metadata was incomplete; preview uses route parsing fallback.'
        : 'Repository metadata could not be resolved.',
    };
  } catch (error) {
    console.error('[gh-html-preview] failed to parse embedded data:', error);
    return {
      html: null,
      repoRef: fallback,
      source: fallback ? 'url-fallback' : 'unavailable',
      diagnostic: fallback
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

export async function fetchPublicFile(
  repoRef: RepoRef,
  signal: AbortSignal,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
): Promise<string> {
  const response = await fetch(buildRawUrl(repoRef), {
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) {
    throw new Error(`Public raw file returned HTTP ${response.status}.`);
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`HTML exceeds ${maxBytes} byte limit.`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`HTML exceeds ${maxBytes} byte limit.`);
    }
    return new TextDecoder().decode(bytes);
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
        throw new Error(`HTML exceeds ${maxBytes} byte limit.`);
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
  return new TextDecoder().decode(bytes);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
