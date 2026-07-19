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

describe('network-error retry path', () => {
  it('retries a TypeError network failure three times before propagating', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    globalThis.fetch = fetchMock;
    const retries: Array<{ attempt: number; reason: number | Error }> = [];

    await expect(
      fetchWithRetry('https://example.test/file', {}, {
        baseDelayMs: 0,
        onRetry: (attempt, reason) => retries.push({ attempt, reason }),
      }),
    ).rejects.toBeInstanceOf(TypeError);

    expect(fetchMock).toHaveBeenCalledTimes(AUTOMATIC_RETRY_COUNT + 1);
    expect(retries).toHaveLength(AUTOMATIC_RETRY_COUNT);
    expect(retries.map((r) => r.attempt)).toEqual([1, 2, 3]);
    retries.forEach((r) => expect(r.reason).toBeInstanceOf(TypeError));
  });

  it('succeeds once the network recovers within the retry budget', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock;

    const response = await fetchWithRetry('https://example.test/file', {}, {
      baseDelayMs: 0,
    });

    expect(await response.text()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not treat a non-Error rejection reason as a retryable response', async () => {
    // fetchWithRetry wraps non-Error reasons in an Error before invoking onRetry.
    const fetchMock = vi.fn().mockRejectedValue('string-rejection');
    globalThis.fetch = fetchMock;
    const reasons: unknown[] = [];

    await expect(
      fetchWithRetry('https://example.test/file', {}, {
        baseDelayMs: 0,
        onRetry: (_attempt, reason) => reasons.push(reason),
      }),
    ).rejects.toBe('string-rejection');

    expect(fetchMock).toHaveBeenCalledTimes(AUTOMATIC_RETRY_COUNT + 1);
    expect(reasons).toHaveLength(AUTOMATIC_RETRY_COUNT);
    reasons.forEach((reason) => expect(reason).toBeInstanceOf(Error));
  });

  it('schedules exponential backoff (250/500/1000ms) between network-error retries', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      globalThis.fetch = fetchMock;

      const pending = fetchWithRetry('https://example.test/file');

      // Attach the rejection handler up front so the final throw never surfaces
      // as an unhandled rejection while fake timers drain the microtask queue.
      const assertion = expect(pending).rejects.toBeInstanceOf(TypeError);

      // attempt 0 fails immediately (microtask), schedules the first backoff.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(249);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); // 250ms total
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(499);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1); // 750ms total
      expect(fetchMock).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1); // 1750ms total
      expect(fetchMock).toHaveBeenCalledTimes(4);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('retry-after header parsing', () => {
  it('caps a numeric retry-after (seconds) at 3000ms', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('retry', { status: 503, headers: { 'retry-after': '5' } }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      globalThis.fetch = fetchMock;

      const pending = fetchWithRetry('https://example.test/file');
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // '5' seconds = 5000ms, capped at 3000ms.
      await vi.advanceTimersByTimeAsync(2999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); // 3000ms total
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const response = await pending;
      expect(response.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps very large retry-after values at 3000ms', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('retry', { status: 503, headers: { 'retry-after': '99999' } }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      globalThis.fetch = fetchMock;

      const pending = fetchWithRetry('https://example.test/file');
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); // 3000ms total — cap engages
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const response = await pending;
      expect(response.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('parses an HTTP-date retry-after header (capped at 3000ms)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const retryAfterDate = new Date('2026-01-01T00:00:05Z'); // 5s in the future
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('retry', {
            status: 503,
            headers: { 'retry-after': retryAfterDate.toUTCString() },
          }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      globalThis.fetch = fetchMock;

      const pending = fetchWithRetry('https://example.test/file');
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // 5s diff capped to 3000ms.
      await vi.advanceTimersByTimeAsync(2999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); // 3000ms total
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const response = await pending;
      expect(response.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps a retry-after date in the past to a 0ms delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
    try {
      const retryAfterDate = new Date('2026-01-01T00:00:00Z'); // 10s in the past
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('retry', {
            status: 503,
            headers: { 'retry-after': retryAfterDate.toUTCString() },
          }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      globalThis.fetch = fetchMock;

      const pending = fetchWithRetry('https://example.test/file');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      // Past date → Math.max(0, negative) = 0 → retryDelay resolves
      // immediately (as a microtask), so the second attempt fires without
      // advancing the clock.
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const response = await pending;
      expect(response.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to base backoff when retry-after is malformed', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('retry', {
            status: 503,
            headers: { 'retry-after': 'not-a-date' },
          }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      globalThis.fetch = fetchMock;

      const pending = fetchWithRetry('https://example.test/file', {}, { baseDelayMs: 250 });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Malformed → null → baseDelayMs * 2^0 = 250ms fallback.
      await vi.advanceTimersByTimeAsync(249);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); // 250ms total
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const response = await pending;
      expect(response.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
