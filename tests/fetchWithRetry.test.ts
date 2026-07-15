import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOMATIC_RETRY_COUNT,
  fetchWithRetry,
  isTransientResponse,
} from '../utils/fetchWithRetry';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('automatic fetch retries', () => {
  it('retries a transient response three times before succeeding', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('retry 1', { status: 503 }))
      .mockResolvedValueOnce(new Response('retry 2', { status: 503 }))
      .mockResolvedValueOnce(new Response('retry 3', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock;
    const retries: number[] = [];

    const response = await fetchWithRetry('https://example.test/file', {}, {
      baseDelayMs: 0,
      onRetry: (attempt) => retries.push(attempt),
    });

    expect(await response.text()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(AUTOMATIC_RETRY_COUNT + 1);
    expect(retries).toEqual([1, 2, 3]);
  });

  it('returns the final transient response after retry exhaustion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('still unavailable', { status: 503 }),
    );
    globalThis.fetch = fetchMock;

    const response = await fetchWithRetry('https://example.test/file', {}, {
      baseDelayMs: 0,
    });

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry permanent client failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('missing', { status: 404 }),
    );
    globalThis.fetch = fetchMock;

    expect(
      (await fetchWithRetry('https://example.test/file')).status,
    ).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts during backoff without issuing another request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('unavailable', { status: 503 }),
    );
    globalThis.fetch = fetchMock;

    const pending = fetchWithRetry(
      'https://example.test/file',
      { signal: controller.signal },
      { baseDelayMs: 1_000 },
    );
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('limits retries to transient status codes', () => {
    expect(isTransientResponse({ status: 408 })).toBe(true);
    expect(isTransientResponse({ status: 425 })).toBe(true);
    expect(isTransientResponse({ status: 429 })).toBe(true);
    expect(isTransientResponse({ status: 500 })).toBe(true);
    expect(isTransientResponse({ status: 404 })).toBe(false);
  });
});
