export const SANDBOX_READY = 'gh-html-preview:sandbox-ready' as const;
export const SANDBOX_RENDER = 'gh-html-preview:sandbox-render' as const;

export interface SandboxReadyMessage {
  kind: typeof SANDBOX_READY;
  channel: string;
  instance: string;
}

export interface SandboxRenderMessage {
  kind: typeof SANDBOX_RENDER;
  channel: string;
  index: number;
  total: number;
  chunk: string;
}

export function isSandboxReadyMessage(
  value: unknown,
): value is SandboxReadyMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.kind === SANDBOX_READY &&
    typeof record.channel === 'string' &&
    typeof record.instance === 'string'
  );
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
    Number.isInteger(record.index) &&
    Number.isInteger(record.total) &&
    typeof record.chunk === 'string' &&
    (record.index as number) >= 0 &&
    (record.total as number) > 0 &&
    (record.index as number) < (record.total as number)
  );
}

export function postSandboxDocument(
  target: Window,
  channel: string,
  html: string,
): void {
  const chunkSize = 64 * 1024;
  const total = Math.max(1, Math.ceil(html.length / chunkSize));
  for (let index = 0; index < total; index += 1) {
    target.postMessage(
      {
        kind: SANDBOX_RENDER,
        channel,
        index,
        total,
        chunk: html.slice(index * chunkSize, (index + 1) * chunkSize),
      } satisfies SandboxRenderMessage,
      '*',
    );
  }
}
