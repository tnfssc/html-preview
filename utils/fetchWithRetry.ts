export const AUTOMATIC_RETRY_COUNT = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const MAX_RETRY_AFTER_MS = 3_000;

interface FetchRetryOptions {
  retries?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, reason: number | Error) => void;
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: FetchRetryOptions = {},
): Promise<Response> {
  const retries = options.retries ?? AUTOMATIC_RETRY_COUNT;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const signal = init.signal ?? undefined;

  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt >= retries) throw error;
      const reason = error instanceof Error ? error : new Error('Network request failed.');
      options.onRetry?.(attempt + 1, reason);
      await retryDelay(baseDelayMs * 2 ** attempt, signal);
      continue;
    }

    if (!isTransientResponse(response) || attempt >= retries) {
      return response;
    }
    options.onRetry?.(attempt + 1, response.status);
    const delay = retryAfterDelay(response) ?? baseDelayMs * 2 ** attempt;
    await response.body?.cancel();
    await retryDelay(delay, signal);
  }
}

export function isTransientResponse(response: Pick<Response, 'status'>): boolean {
  return (
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  );
}

function retryAfterDelay(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1_000));
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
}

function retryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('Aborted', 'AbortError'),
    );
  }
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });

    function finish() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }

    function abort() {
      globalThis.clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    }
  });
}
