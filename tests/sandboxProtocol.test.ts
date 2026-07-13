import { describe, expect, it, vi } from 'vitest';
import {
  isSandboxRenderMessage,
  postSandboxDocument,
} from '../utils/sandboxProtocol';

describe('sandbox document transport', () => {
  it('splits large documents into ordered bounded messages', () => {
    const messages: unknown[] = [];
    const target = {
      postMessage: vi.fn((message: unknown) => messages.push(message)),
    } as unknown as Window;
    const html = 'x'.repeat(150_000);

    postSandboxDocument(target, 'channel', html);

    expect(messages).toHaveLength(3);
    expect(messages.every(isSandboxRenderMessage)).toBe(true);
    const typed = messages.filter(isSandboxRenderMessage);
    expect(typed.map((message) => message.index)).toEqual([0, 1, 2]);
    expect(typed.every((message) => message.total === 3)).toBe(true);
    expect(typed.map((message) => message.chunk).join('')).toBe(html);
    expect(Math.max(...typed.map((message) => message.chunk.length))).toBe(
      64 * 1024,
    );
  });
});
