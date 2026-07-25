export type PreviewAnchor =
  | { kind: 'element'; css: string[] }
  | {
      kind: 'text-range';
      css: string[];
      quote: string;
      start: number;
      end: number;
    };

export interface AnchorMetadata {
  v: 1;
  path: string;
  anchor: PreviewAnchor;
}

export interface AnchoredComment {
  id: string;
  path: string;
  anchor: PreviewAnchor;
  excerpt: string;
  author: string;
  url: string;
}

export const ANCHOR_MARKER = 'gh-html-preview-anchor:';

export const ANCHORS_MESSAGE = 'gh-html-preview:anchors' as const;
export const ANCHOR_FOCUS_MESSAGE = 'gh-html-preview:anchor-focus' as const;
export const ANCHOR_PROPOSE_MESSAGE = 'gh-html-preview:anchor-propose' as const;
export const ANCHOR_ACTIVATE_MESSAGE =
  'gh-html-preview:anchor-activate' as const;
export const ANCHORS_REQUEST_MESSAGE =
  'gh-html-preview:anchors-request' as const;
export const ANCHOR_FOCUSED_MESSAGE =
  'gh-html-preview:anchor-focused' as const;

export function encodeAnchorComment(metadata: AnchorMetadata): string {
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // "." replaces "+": base64url's "-" could produce "--", which is invalid
  // inside HTML comments and risks corrupting the rendered GitHub comment.
  const encoded = btoa(binary)
    .replaceAll('+', '.')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return `<!-- ${ANCHOR_MARKER}${encoded} -->`;
}

export function decodeAnchorComment(text: string): AnchorMetadata | null {
  const start = text.indexOf(ANCHOR_MARKER);
  if (start < 0) return null;
  const encoded = text
    .slice(start + ANCHOR_MARKER.length)
    .trim()
    .split(/\s/)[0];
  if (!encoded) return null;
  try {
    const base64 = encoded.replaceAll('.', '+').replaceAll('_', '/');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as AnchorMetadata | null;
    if (
      !parsed ||
      parsed.v !== 1 ||
      typeof parsed.path !== 'string' ||
      !parsed.anchor ||
      typeof parsed.anchor !== 'object'
    ) {
      return null;
    }
    const anchor = parsed.anchor;
    if (
      !Array.isArray(anchor.css) ||
      anchor.css.some((segment) => typeof segment !== 'string')
    ) {
      return null;
    }
    if (anchor.kind === 'text-range') {
      if (
        typeof anchor.quote !== 'string' ||
        typeof anchor.start !== 'number' ||
        typeof anchor.end !== 'number'
      ) {
        return null;
      }
    } else if (anchor.kind !== 'element') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
