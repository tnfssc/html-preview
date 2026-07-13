const DEBUG_ENABLED = import.meta.env.MODE === 'debug';

type DebugValue = string | number | boolean | null | undefined;

export function debugLog(
  scope: string,
  event: string,
  details: Record<string, DebugValue> = {},
): void {
  if (!DEBUG_ENABLED) return;
  console.info('[gh-html-preview:debug]', {
    at: new Date().toISOString(),
    scope,
    event,
    ...redactDetails(details),
  });
}

export function debugError(
  scope: string,
  event: string,
  error: unknown,
  details: Record<string, DebugValue> = {},
): void {
  if (!DEBUG_ENABLED) return;
  console.error('[gh-html-preview:debug]', {
    at: new Date().toISOString(),
    scope,
    event,
    error:
      error instanceof Error
        ? redactDebugText(`${error.name}: ${error.message}`)
        : redactDebugText(String(error)),
    ...redactDetails(details),
  });
}

export function redactDebugText(value: string): string {
  return value
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{8,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
}

function redactDetails(
  details: Record<string, DebugValue>,
): Record<string, DebugValue> {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      typeof value === 'string' ? redactDebugText(value) : value,
    ]),
  );
}
