// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildContentsApiUrl,
  buildRawUrl,
  fetchRepositoryBytes,
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
  });
});
