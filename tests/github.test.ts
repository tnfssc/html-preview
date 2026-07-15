// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGitHubSessionRawUrl,
  buildJsdelivrUrl,
  buildRawUrl,
  fetchRepositoryBytes,
  fetchRepositoryFile,
  parseBlobUrl,
  parseHtmlDiffUrl,
  parsePrFilesUrl,
} from '../utils/github';
import type { RepoRef } from '../utils/types';

const repoRef: RepoRef = {
  owner: 'private-owner',
  repo: 'private-repo',
  ref: '0123456789abcdef0123456789abcdef01234567',
  path: 'reports/private report.html',
};
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('repository fetching', () => {
  it('pins every repository URL to the supplied exact ref and encodes paths', () => {
    const pullHead: RepoRef = {
      owner: 'fork owner',
      repo: 'fork-repo',
      ref: 'f00dbabe0123456789abcdef0123456789abcdef',
      path: 'reports/April report/index.html',
    };

    expect(buildRawUrl(pullHead)).toBe(
      'https://raw.githubusercontent.com/fork%20owner/fork-repo/f00dbabe0123456789abcdef0123456789abcdef/reports/April%20report/index.html',
    );
    expect(buildJsdelivrUrl(pullHead, 'assets/chart #1.js')).toBe(
      'https://cdn.jsdelivr.net/gh/fork%20owner/fork-repo@f00dbabe0123456789abcdef0123456789abcdef/assets/chart%20%231.js',
    );

  });

  it('parses encoded blob and PR files routes while rejecting adjacent GitHub routes', () => {
    expect(
      parseBlobUrl(
        'https://github.com/acme%20org/reports/blob/0123456789abcdef0123456789abcdef01234567/docs/April%20report.html',
      ),
    ).toEqual({
      owner: 'acme org',
      repo: 'reports',
      ref: '0123456789abcdef0123456789abcdef01234567',
      path: 'docs/April report.html',
    });
    expect(
      parsePrFilesUrl('https://github.com/acme/reports/pull/42/files'),
    ).toEqual({ owner: 'acme', repo: 'reports', pullNumber: '42' });
    expect(
      parsePrFilesUrl('https://github.com/acme/reports/pull/42/commits'),
    ).toBeNull();
    expect(
      parseHtmlDiffUrl('https://github.com/acme/reports/pull/42/changes'),
    ).toEqual({
      kind: 'pull',
      owner: 'acme',
      repo: 'reports',
      pullNumber: '42',
    });
    expect(
      parseHtmlDiffUrl(
        'https://github.com/acme/reports/commit/0123456789abcdef0123456789abcdef01234567',
      ),
    ).toEqual({
      kind: 'commit',
      owner: 'acme',
      repo: 'reports',
      head: '0123456789abcdef0123456789abcdef01234567',
    });
    expect(
      parseHtmlDiffUrl(
        'https://github.com/acme/reports/pull/42/changes/0123456789abcdef0123456789abcdef01234567',
      ),
    ).toEqual({
      kind: 'commit',
      owner: 'acme',
      repo: 'reports',
      head: '0123456789abcdef0123456789abcdef01234567',
    });
    expect(
      parseHtmlDiffUrl(
        'https://github.com/acme/reports/compare/release%2Fv1...release%2Fv2',
      ),
    ).toEqual({
      kind: 'compare',
      owner: 'acme',
      repo: 'reports',
      base: 'release/v1',
      head: 'release/v2',
    });
    expect(
      parseHtmlDiffUrl('https://github.com/acme/reports/releases/tag/v2'),
    ).toBeNull();
  });

  it('fetches public files without authorization', async () => {
    const fetchMock = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        new Response('public bytes', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const resource = await fetchRepositoryBytes(
      repoRef,
      repoRef.path,
      new AbortController().signal,
    );

    expect(resource.authenticated).toBe(false);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(buildRawUrl(repoRef));
    expect(init?.headers).toBeUndefined();
  });

  it('rejects private access without a GitHub browser session', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      fetchRepositoryBytes(
        repoRef,
        repoRef.path,
        new AbortController().signal,
        { privateRepo: true },
      ),
    ).rejects.toThrow(
      'Private repository access requires a signed-in GitHub browser session.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries a public server error without switching to the GitHub session', async () => {
    const fetchMock = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        new Response('outage', {
          status: 500,
          headers: { 'retry-after': '0' },
        }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      fetchRepositoryBytes(repoRef, repoRef.path, new AbortController().signal),
    ).rejects.toThrow('Public raw file returned HTTP 500.');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      fetchMock.mock.calls.every(
        ([url]) => url === buildRawUrl(repoRef),
      ),
    ).toBe(true);
  });

  it('uses the signed-in GitHub session for private repository content', async () => {
    vi.stubGlobal(
      'location',
      new URL('https://github.com/acme/reports/blob/main/report.html'),
    );
    const response = new Response('<h1>Session file</h1>', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
    Object.defineProperty(response, 'url', {
      value:
        'https://raw.githubusercontent.com/acme/reports/main/report.html?token=redacted',
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const resource = await fetchRepositoryFile(
      repoRef,
      new AbortController().signal,
      { privateRepo: true },
    );
    expect(resource.text).toBe('<h1>Session file</h1>');
    expect(resource.authenticated).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      buildGitHubSessionRawUrl(repoRef),
      expect.objectContaining({
        credentials: 'same-origin',
        redirect: 'follow',
      }),
    );
  });

  it('rejects session responses that do not finish on GitHub raw content', async () => {
    vi.stubGlobal(
      'location',
      new URL('https://github.com/acme/reports/blob/main/report.html'),
    );
    const response = new Response('<html>Sign in</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    Object.defineProperty(response, 'url', {
      value: 'https://github.com/login',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(
      fetchRepositoryFile(repoRef, new AbortController().signal, {
        privateRepo: true,
      }),
    ).rejects.toThrow(
      'Private repository access requires a signed-in GitHub browser session.',
    );
  });

  it('propagates request aborts without attempting authentication fallback', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const pending = fetchRepositoryBytes(
      repoRef,
      repoRef.path,
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects declared oversized responses before reading their body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      cancel,
    });
    globalThis.fetch = vi.fn(
      async (): Promise<Response> =>
        new Response(body, {
          status: 200,
          headers: { 'content-length': '5' },
        }),
    ) as typeof fetch;

    await expect(
      fetchRepositoryBytes(repoRef, repoRef.path, new AbortController().signal, {
        maxBytes: 4,
      }),
    ).rejects.toThrow('Repository resource exceeds 4 byte limit.');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
