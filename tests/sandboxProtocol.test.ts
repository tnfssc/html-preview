import { describe, expect, it, vi } from 'vitest';
import {
  SANDBOX_READY,
  isSandboxReadyMessage,
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

describe('isSandboxReadyMessage', () => {
  it('accepts a valid ready message', () => {
    const message = {
      kind: SANDBOX_READY,
      channel: 'channel-abc',
      instance: 'instance-123',
    };
    expect(isSandboxReadyMessage(message)).toBe(true);
  });

  it('narrows the type for a valid ready message', () => {
    const message: unknown = {
      kind: SANDBOX_READY,
      channel: 'channel-abc',
      instance: 'instance-123',
    };
    if (isSandboxReadyMessage(message)) {
      expect(message.kind).toBe(SANDBOX_READY);
      expect(message.channel).toBe('channel-abc');
      expect(message.instance).toBe('instance-123');
    } else {
      throw new Error('expected discriminator to accept a valid ready message');
    }
  });

  it('rejects null', () => {
    expect(isSandboxReadyMessage(null)).toBe(false);
  });

  it('rejects arrays', () => {
    expect(isSandboxReadyMessage([SANDBOX_READY, 'channel-abc'])).toBe(false);
  });

  it('rejects primitives', () => {
    expect(isSandboxReadyMessage(undefined)).toBe(false);
    expect(isSandboxReadyMessage(42)).toBe(false);
    expect(isSandboxReadyMessage('sandbox-ready')).toBe(false);
    expect(isSandboxReadyMessage(true)).toBe(false);
  });

  it('rejects an object missing the kind field', () => {
    expect(isSandboxReadyMessage({ channel: 'channel-abc' })).toBe(false);
  });

  it('rejects an object with the wrong kind', () => {
    expect(
      isSandboxReadyMessage({
        kind: 'gh-html-preview:sandbox-render',
        channel: 'channel-abc',
        instance: 'instance-123',
      }),
    ).toBe(false);
  });

  it('rejects an object missing the channel field', () => {
    expect(
      isSandboxReadyMessage({
        kind: SANDBOX_READY,
        instance: 'instance-123',
      }),
    ).toBe(false);
  });

  it('rejects a non-string channel', () => {
    expect(
      isSandboxReadyMessage({
        kind: SANDBOX_READY,
        channel: 123,
        instance: 'instance-123',
      }),
    ).toBe(false);
    expect(
      isSandboxReadyMessage({
        kind: SANDBOX_READY,
        channel: null,
        instance: 'instance-123',
      }),
    ).toBe(false);
    expect(
      isSandboxReadyMessage({
        kind: SANDBOX_READY,
        channel: { x: 1 },
        instance: 'instance-123',
      }),
    ).toBe(false);
  });

  it('rejects a missing or non-string instance', () => {
    expect(
      isSandboxReadyMessage({
        kind: SANDBOX_READY,
        channel: 'channel-abc',
      }),
    ).toBe(false);
    expect(
      isSandboxReadyMessage({
        kind: SANDBOX_READY,
        channel: 'channel-abc',
        instance: 123,
      }),
    ).toBe(false);
  });

  it('ignores extra fields when kind, channel, and instance are valid', () => {
    expect(
      isSandboxReadyMessage({
        kind: SANDBOX_READY,
        channel: 'channel-abc',
        instance: 'instance-123',
        extra: 'ignored',
      }),
    ).toBe(true);
  });

  it('does not accept a render message as a ready message', () => {
    const renderMessage = {
      kind: 'gh-html-preview:sandbox-render',
      channel: 'channel-abc',
      index: 0,
      total: 1,
      chunk: 'x',
    };
    expect(isSandboxReadyMessage(renderMessage)).toBe(false);
  });
});
