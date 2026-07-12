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
    ...details,
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
        ? `${error.name}: ${error.message}`
        : String(error),
    ...details,
  });
}
