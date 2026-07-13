// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildContentsApiUrl,
  buildJsdelivrUrl,
  buildRawUrl,
  fetchRepositoryBytes,
  fetchRepositoryFile,
  parseBlobUrl,
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
    expect(buildContentsApiUrl(pullHead)).toBe(
      'https://api.github.com/repos/fork%20owner/fork-repo/contents/reports/April%20report/index.html?ref=f00dbabe0123456789abcdef0123456789abcdef',
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
  });

  it('sends private token only to GitHub Contents API', async () => {
    const fetchMock = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        new Response('private bytes', {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const resource = await fetchRepositoryBytes(
      repoRef,
      'assets/private image.png',
      new AbortController().signal,
      { token: 'secret-token', privateRepo: true },
    );

    expect(new TextDecoder().decode(resource.bytes)).toBe('private bytes');
    expect(resource.authenticated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.github.com/repos/private-owner/private-repo/contents/assets/private%20image.png?ref=0123456789abcdef0123456789abcdef01234567',
    );
    expect(String(url)).not.toContain('secret-token');
    expect(init).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: {
        Accept: 'application/vnd.github.raw+json',
        Authorization: 'Bearer secret-token',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
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

  it('falls back from unavailable raw content to authenticated API', async () => {
    let requestCount = 0;
    const fetchMock = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> => {
        requestCount += 1;
        return requestCount === 1
          ? new Response('missing', { status: 404 })
          : new Response('private bytes', { status: 200 });
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const resource = await fetchRepositoryBytes(
      repoRef,
      repoRef.path,
      new AbortController().signal,
      { token: 'secret-token' },
    );

    expect(resource.authenticated).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      buildRawUrl(repoRef),
      expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
    );
    expect(fetchMock.mock.calls[1][0]).toBe(buildContentsApiUrl(repoRef));
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      headers: { Authorization: 'Bearer secret-token' },
    });
  });

  it('never sends a configured token to public raw content', async () => {
    const fetchMock = vi.fn(
      async (): Promise<Response> => new Response('public bytes', { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await fetchRepositoryFile(repoRef, new AbortController().signal, {
      token: 'secret-token',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([
      buildRawUrl(repoRef),
      expect.not.objectContaining({ headers: expect.anything() }),
    ]);
  });

  it('rejects private access without a token before making a request', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      fetchRepositoryBytes(
        repoRef,
        repoRef.path,
        new AbortController().signal,
        { privateRepo: true },
      ),
    ).rejects.toThrow('Private repository access requires a saved GitHub token.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry a public server error through the authenticated API', async () => {
    const fetchMock = vi.fn(
      async (): Promise<Response> => new Response('outage', { status: 500 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      fetchRepositoryBytes(repoRef, repoRef.path, new AbortController().signal, {
        token: 'secret-token',
      }),
    ).rejects.toThrow('Public raw file returned HTTP 500.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      buildRawUrl(repoRef),
      expect.not.objectContaining({ headers: expect.anything() }),
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

    const pending = fetchRepositoryBytes(repoRef, repoRef.path, controller.signal, {
      token: 'secret-token',
    });
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
