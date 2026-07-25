import {
  ANCHOR_MARKER,
  decodeAnchorComment,
  type AnchoredComment,
  type AnchorMetadata,
} from './annotations';
import { debugError, debugLog } from './debug';
import { fetchWithRetry } from './fetchWithRetry';

export interface PullCoordinate {
  owner: string;
  repo: string;
  pullNumber: string;
}

export interface CommentSource {
  id: string;
  container: Element;
  rawBody: string | null;
  editFormPath: string | null;
}

// GitHub strips HTML comments from rendered comment bodies. Raw markdown is
// available from the "Copy Markdown" clipboard-copy value on logged-out
// pages; logged-in pages lazy-load their menus, so the raw body must come
// from each comment's lazy edit_form include-fragment instead.
export function collectCommentSources(root: Document | HTMLElement): CommentSource[] {
  const sources: CommentSource[] = [];
  for (const container of Array.from(
    root.querySelectorAll('[id^="issuecomment-"]'),
  )) {
    if (!/^issuecomment-\d+$/.test(container.id)) continue;
    const rawBody = Array.from(
      container.querySelectorAll('clipboard-copy[value]'),
    )
      .map((copy) => copy.getAttribute('value') ?? '')
      .find((value) => value.length > 0);
    const editFormSrc = Array.from(
      container.querySelectorAll('include-fragment[src*="edit_form"]'),
    )
      .map((fragment) => fragment.getAttribute('src') ?? '')
      .find((src) => src.includes('/issue_comments/'));
    sources.push({
      id: container.id,
      container,
      rawBody: rawBody ?? null,
      editFormPath: editFormSrc ?? null,
    });
  }
  return sources;
}

export function anchorsFromSources(
  sources: CommentSource[],
  bodies: ReadonlyMap<string, string>,
  coordinate: PullCoordinate,
): AnchoredComment[] {
  const anchors: AnchoredComment[] = [];
  const { owner, repo, pullNumber } = coordinate;
  for (const source of sources) {
    const raw = source.rawBody ?? bodies.get(source.id);
    if (!raw || !raw.includes(ANCHOR_MARKER)) continue;
    const metadata = decodeAnchorComment(raw);
    if (!metadata) continue;
    const body = source.container.querySelector(
      '.comment-body, .edit-comment-hide',
    );
    const excerpt = (body?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
    const author =
      source.container.querySelector('.author')?.textContent?.trim() ||
      'unknown';
    anchors.push({
      id: source.id,
      path: metadata.path,
      anchor: metadata.anchor,
      excerpt,
      author,
      url: `https://github.com/${owner}/${repo}/pull/${pullNumber}#${source.id}`,
    });
  }
  return anchors;
}

const EDIT_FORM_CONCURRENCY = 4;

async function fetchRawBody(
  editFormPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetchWithRetry(editFormPath, {
      credentials: 'same-origin',
      signal,
    });
    if (!response.ok) return null;
    const doc = new DOMParser().parseFromString(
      await response.text(),
      'text/html',
    );
    return doc.querySelector('textarea')?.value ?? null;
  } catch {
    return null;
  }
}

// Resolves raw bodies for sources missing one, fetching edit_form fragments
// with bounded concurrency. Results are merged into `bodies` (caller's cache).
export async function resolveRawBodies(
  sources: CommentSource[],
  bodies: Map<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const missing = sources.filter(
    (source) =>
      source.rawBody === null &&
      !bodies.has(source.id) &&
      source.editFormPath !== null,
  );
  for (
    let index = 0;
    index < missing.length;
    index += EDIT_FORM_CONCURRENCY
  ) {
    if (signal?.aborted) return;
    const chunk = missing.slice(index, index + EDIT_FORM_CONCURRENCY);
    const raws = await Promise.all(
      chunk.map((source) =>
        fetchRawBody(source.editFormPath as string, signal),
      ),
    );
    chunk.forEach((source, offset) => {
      const raw = raws[offset];
      if (raw !== null) bodies.set(source.id, raw);
    });
  }
}

export class PullAnnotationSession {
  anchors: AnchoredComment[] = [];
  private readonly coordinate: PullCoordinate;
  private readonly listeners = new Set<() => void>();
  private readonly bodies = new Map<string, string>();

  constructor(coordinate: PullCoordinate) {
    this.coordinate = coordinate;
  }

  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(signal?: AbortSignal): Promise<boolean> {
    const { owner, repo, pullNumber } = this.coordinate;
    try {
      const response = await fetchWithRetry(
        `/${owner}/${repo}/pull/${pullNumber}`,
        { credentials: 'same-origin', signal },
      );
      if (!response.ok) {
        debugLog('annotations', 'conversation-fetch-failed', {
          status: response.status,
        });
        return false;
      }
      const doc = new DOMParser().parseFromString(
        await response.text(),
        'text/html',
      );
      const sources = collectCommentSources(doc);
      const present = new Set(sources.map((source) => source.id));
      for (const id of Array.from(this.bodies.keys())) {
        if (!present.has(id)) this.bodies.delete(id);
      }
      await resolveRawBodies(sources, this.bodies, signal);
      if (signal?.aborted) return false;
      this.anchors = anchorsFromSources(sources, this.bodies, this.coordinate);
      debugLog('annotations', 'anchors-refreshed', {
        anchors: this.anchors.length,
        comments: sources.length,
      });
      for (const listener of this.listeners) listener();
      return true;
    } catch (error) {
      if (!signal?.aborted) {
        debugError('annotations', 'refresh-failed', error);
      }
      return false;
    }
  }

  conversationUrl(): string {
    const { owner, repo, pullNumber } = this.coordinate;
    return `/${owner}/${repo}/pull/${pullNumber}`;
  }
}

export interface ComposePayload {
  path: string;
  body: string;
}

export function encodeComposeHash(payload: ComposePayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary)
    .replaceAll('+', '.')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return `#ghp-compose-${encoded}`;
}

function decodeComposeHash(hash: string): ComposePayload | null {
  const match = /^#ghp-compose-(.+)$/.exec(hash);
  if (!match) return null;
  try {
    const base64 = match[1].replaceAll('.', '+').replaceAll('_', '/');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof parsed?.path !== 'string' ||
      typeof parsed?.body !== 'string'
    ) {
      return null;
    }
    return parsed as ComposePayload;
  } catch {
    return null;
  }
}

function findComposerTextarea(): HTMLTextAreaElement | null {
  for (const form of Array.from(document.querySelectorAll('form'))) {
    if (!/\/pull\/\d+\/comment(\?|$)/.test(form.getAttribute('action') ?? '')) {
      continue;
    }
    const textarea = form.querySelector<HTMLTextAreaElement>(
      'textarea[name="comment[body]"]',
    );
    if (textarea) return textarea;
  }
  return null;
}

function fillComposer(body: string): void {
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    const textarea = findComposerTextarea();
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(textarea, body);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.scrollIntoView({ block: 'center' });
      textarea.focus();
      window.clearInterval(timer);
      debugLog('annotations', 'composer-prefilled');
      return;
    }
    if (attempts >= 60) window.clearInterval(timer);
  }, 500);
}

export function injectConversationJumpButtons(
  coordinate: PullCoordinate,
): () => void {
  const { owner, repo, pullNumber } = coordinate;
  const compose = decodeComposeHash(location.hash);
  if (compose) {
    history.replaceState(null, '', location.pathname + location.search);
    fillComposer(compose.body);
  }
  const bodies = new Map<string, string>();
  const pending = new Set<string>();
  const addJumpButton = (source: CommentSource) => {
    if (source.container.querySelector('.gh-html-preview-jump')) return;
    const body = source.container.querySelector('.comment-body');
    if (!body) return;
    const link = document.createElement('a');
    link.className = 'gh-html-preview-jump btn btn-sm';
    link.textContent = 'Show in HTML preview';
    link.href = `/${owner}/${repo}/pull/${pullNumber}/files#ghp-anchor-${source.id}`;
    link.style.marginTop = '8px';
    link.style.display = 'inline-block';
    body.append(link);
  };
  const checkSource = (source: CommentSource) => {
    if (source.container.querySelector('.gh-html-preview-jump')) return;
    const raw = source.rawBody ?? bodies.get(source.id);
    if (raw !== undefined && raw !== null) {
      if (raw.includes(ANCHOR_MARKER) && decodeAnchorComment(raw)) {
        addJumpButton(source);
      }
      return;
    }
    if (!source.editFormPath || pending.has(source.id)) return;
    pending.add(source.id);
    void fetchRawBody(source.editFormPath).then((fetched) => {
      pending.delete(source.id);
      if (fetched === null) return;
      bodies.set(source.id, fetched);
      if (
        fetched.includes(ANCHOR_MARKER) &&
        decodeAnchorComment(fetched)
      ) {
        addJumpButton(source);
      }
    });
  };
  // Logged-in pages lack clipboard-copy; only resolve raw bodies for
  // comments approaching the viewport instead of fetching every edit form.
  const observed = new WeakMap<Element, CommentSource>();
  const visibility = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      visibility.unobserve(entry.target);
      const source = observed.get(entry.target);
      if (source) checkSource(source);
    }
  });
  const scan = () => {
    for (const source of collectCommentSources(document)) {
      if (source.container.querySelector('.gh-html-preview-jump')) continue;
      if (source.rawBody !== null) {
        checkSource(source);
      } else {
        observed.set(source.container, source);
        visibility.observe(source.container);
      }
    }
  };
  let timer: number | null = null;
  const observer = new MutationObserver(() => {
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      scan();
    }, 300);
  });
  scan();
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    visibility.disconnect();
    if (timer !== null) window.clearTimeout(timer);
  };
}
