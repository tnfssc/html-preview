export const SANDBOX_READY = 'gh-html-preview:sandbox-ready' as const;
export const SANDBOX_RENDER = 'gh-html-preview:sandbox-render' as const;

export interface SandboxReadyMessage {
  kind: typeof SANDBOX_READY;
  channel: string;
}

export interface SandboxRenderMessage {
  kind: typeof SANDBOX_RENDER;
  channel: string;
  html: string;
}

export function isSandboxReadyMessage(
  value: unknown,
): value is SandboxReadyMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.kind === SANDBOX_READY && typeof record.channel === 'string';
}

export function isSandboxRenderMessage(
  value: unknown,
): value is SandboxRenderMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.kind === SANDBOX_RENDER &&
    typeof record.channel === 'string' &&
    typeof record.html === 'string'
  );
}
