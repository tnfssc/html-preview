// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  ANCHOR_MARKER,
  decodeAnchorComment,
  encodeAnchorComment,
  type AnchorMetadata,
} from '../utils/annotations';

const textRangeMetadata: AnchorMetadata = {
  v: 1,
  path: 'docs/index.html',
  anchor: {
    kind: 'text-range',
    css: ['div', 'p:nth-of-type(2)'],
    quote: 'Selected "text" — with ünicode and -- dashes',
    start: 4,
    end: 31,
  },
};

const elementMetadata: AnchorMetadata = {
  v: 1,
  path: 'guide/intro page.html',
  anchor: { kind: 'element', css: ['section', 'div:nth-of-type(3)'] },
};

describe('anchor comment codec', () => {
  it('round-trips text-range metadata', () => {
    const comment = encodeAnchorComment(textRangeMetadata);
    expect(comment.startsWith(`<!-- ${ANCHOR_MARKER}`)).toBe(true);
    expect(comment.endsWith('-->')).toBe(true);
    expect(decodeAnchorComment(comment)).toEqual(textRangeMetadata);
  });

  it('round-trips element metadata', () => {
    expect(decodeAnchorComment(encodeAnchorComment(elementMetadata))).toEqual(
      elementMetadata,
    );
  });

  it('never emits a double hyphen, which is invalid inside HTML comments', () => {
    for (const metadata of [textRangeMetadata, elementMetadata]) {
      const comment = encodeAnchorComment(metadata);
      const payload = comment.slice(
        comment.indexOf(ANCHOR_MARKER) + ANCHOR_MARKER.length,
        comment.lastIndexOf('-->'),
      );
      expect(payload).not.toContain('-');
    }
  });

  it('decodes when embedded in surrounding markdown text', () => {
    const embedded = `Looks wrong here.\n\n${encodeAnchorComment(elementMetadata)}\n`;
    expect(decodeAnchorComment(embedded)).toEqual(elementMetadata);
  });

  it('rejects text without the marker', () => {
    expect(decodeAnchorComment('plain comment')).toBeNull();
  });

  it('rejects corrupt payloads', () => {
    expect(decodeAnchorComment(`${ANCHOR_MARKER}not-base64!!!`)).toBeNull();
    expect(decodeAnchorComment(`${ANCHOR_MARKER}`)).toBeNull();
  });

  it('rejects wrong version and malformed anchors', () => {
    const encode = (value: unknown) =>
      `${ANCHOR_MARKER}${btoa(JSON.stringify(value))
        .replaceAll('+', '.')
        .replaceAll('/', '_')
        .replaceAll('=', '')}`;
    expect(decodeAnchorComment(encode({ v: 2, path: 'a', anchor: { kind: 'element', css: [] } }))).toBeNull();
    expect(decodeAnchorComment(encode({ v: 1, path: 'a', anchor: { kind: 'mystery', css: [] } }))).toBeNull();
    expect(decodeAnchorComment(encode({ v: 1, path: 'a', anchor: { kind: 'element', css: ['p', 4] } }))).toBeNull();
    expect(decodeAnchorComment(encode({ v: 1, path: 'a', anchor: { kind: 'text-range', css: ['p'], quote: 9, start: 0, end: 1 } }))).toBeNull();
    expect(decodeAnchorComment(encode({ v: 1, anchor: { kind: 'element', css: [] } }))).toBeNull();
  });
});
