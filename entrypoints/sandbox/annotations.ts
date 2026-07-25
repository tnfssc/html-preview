import {
  ANCHOR_ACTIVATE_MESSAGE,
  ANCHOR_FOCUS_MESSAGE,
  ANCHOR_FOCUSED_MESSAGE,
  ANCHOR_PROPOSE_MESSAGE,
  ANCHORS_MESSAGE,
  ANCHORS_REQUEST_MESSAGE,
  type AnchoredComment,
  type PreviewAnchor,
} from '@/utils/annotations';
import { debugLog } from '@/utils/debug';

const BLOCK_TAGS: Record<string, true> = {
  P: true,
  DIV: true,
  SECTION: true,
  ARTICLE: true,
  ASIDE: true,
  LI: true,
  TD: true,
  TH: true,
  BLOCKQUOTE: true,
  PRE: true,
  FIGURE: true,
  H1: true,
  H2: true,
  H3: true,
  H4: true,
  H5: true,
  H6: true,
};

function cssPath(element: Element | null): string[] {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && current.parentElement) {
    const tag = current.tagName.toLowerCase();
    const siblings = Array.from(current.parentElement.children).filter(
      (sibling) => sibling.tagName.toLowerCase() === tag,
    );
    const index = siblings.indexOf(current) + 1;
    segments.unshift(
      siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag,
    );
    current = current.parentElement;
  }
  return segments;
}

function resolvePath(path: string[]): Element | null {
  if (path.length === 0) return null;
  try {
    return document.querySelector(path.join(' > '));
  } catch {
    return null;
  }
}

function findQuoteRange(root: Element | Document, quote: string): Range | null {
  const needle = quote.slice(0, 80).trim();
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const normalizedNeedle = normalize(needle);
  if (!normalizedNeedle) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node as Text).data;
    if (!normalize(text).includes(normalizedNeedle)) continue;
    const index = text.indexOf(needle.slice(0, 40));
    if (index < 0) continue;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + Math.min(needle.length, text.length - index));
    return range;
  }
  const firstWord = normalize(needle.split(/\s+/)[0] ?? '');
  if (!firstWord || firstWord.length < 3) return null;
  const fallbackWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let fallbackNode: Node | null;
  while ((fallbackNode = fallbackWalker.nextNode())) {
    const text = (fallbackNode as Text).data;
    if (!normalize(text).includes(firstWord)) continue;
    let collected = text;
    while (normalize(collected).length < normalizedNeedle.length) {
      const next = fallbackWalker.nextNode();
      if (!next) break;
      collected += ' ' + (next as Text).data;
    }
    if (!normalize(collected).includes(normalizedNeedle)) continue;
    const range = document.createRange();
    const position = Math.max(0, text.indexOf(firstWord));
    range.setStart(fallbackNode, position);
    range.setEnd(fallbackNode, position + firstWord.length);
    return range;
  }
  return null;
}

function resolveAnchor(anchor: PreviewAnchor): Element | null {
  if (anchor.kind === 'text-range') {
    const element = resolvePath(anchor.css);
    if (element) {
      const range = findQuoteRange(element, anchor.quote);
      const target = range?.startContainer;
      if (target) {
        return target.nodeType === 3 ? target.parentElement : (target as Element);
      }
      return element;
    }
    const fallback = findQuoteRange(document.body, anchor.quote);
    const target = fallback?.startContainer ?? null;
    if (!target) return null;
    return target.nodeType === 3 ? target.parentElement : (target as Element);
  }
  return resolvePath(anchor.css);
}

interface PinEntry {
  comment: AnchoredComment;
  label: number;
  element: Element | null;
  pin: HTMLButtonElement;
}

let channel: string | null = null;
let comments: AnchoredComment[] = [];
let layer: HTMLElement | null = null;
let proposeButton: HTMLButtonElement | null = null;
let pins: PinEntry[] = [];
let layoutScheduled = false;
let pendingFocusId: string | null = null;
let appliedFocusId: string | null = null;
let anchorsSignature = '';

function post(message: Record<string, unknown>): void {
  if (!channel) return;
  parent.postMessage({ ...message, channel }, '*');
}

function ensureLayer(): HTMLElement | null {
  if (layer?.isConnected) return layer;
  if (!document.body) return null;
  layer = document.createElement('div');
  layer.setAttribute('data-gh-html-preview-annotations', '');
  Object.assign(layer.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    zIndex: '2147483646',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.append(layer);
  pins = [];
  return layer;
}

let popover: { element: HTMLElement; entry: PinEntry } | null = null;

function closePopover(): void {
  popover?.element.remove();
  popover = null;
}

function openPopover(entry: PinEntry): void {
  closePopover();
  const host = ensureLayer();
  if (!host) return;
  const card = document.createElement('div');
  card.setAttribute('role', 'dialog');
  Object.assign(card.style, {
    position: 'absolute',
    width: '300px',
    background: '#ffffff',
    color: '#1f2328',
    border: '1px solid #d1d9e0',
    borderRadius: '8px',
    boxShadow: '0 8px 24px rgba(140, 149, 159, 0.4)',
    padding: '10px 12px',
    font: '13px/1.45 -apple-system, "Segoe UI", sans-serif',
    pointerEvents: 'auto',
  } satisfies Partial<CSSStyleDeclaration>);
  const author = document.createElement('div');
  author.textContent = entry.comment.author;
  author.style.fontWeight = '600';
  author.style.marginBottom = '4px';
  const excerpt = document.createElement('div');
  excerpt.textContent = entry.comment.excerpt;
  excerpt.style.marginBottom = '8px';
  excerpt.style.whiteSpace = 'pre-wrap';
  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.textContent = 'View comment on GitHub';
  Object.assign(openButton.style, {
    background: '#1f6feb',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    padding: '4px 10px',
    font: '600 12px/1.4 -apple-system, "Segoe UI", sans-serif',
    cursor: 'pointer',
  } satisfies Partial<CSSStyleDeclaration>);
  openButton.addEventListener('click', (event) => {
    event.stopPropagation();
    post({ kind: ANCHOR_ACTIVATE_MESSAGE, id: entry.comment.id });
  });
  card.append(author, excerpt, openButton);
  card.addEventListener('mousedown', (event) => event.stopPropagation());
  card.addEventListener('mouseup', (event) => event.stopPropagation());
  const left = Number.parseFloat(entry.pin.dataset.x ?? '0') + 22;
  const top = Number.parseFloat(entry.pin.dataset.y ?? '0') - 8;
  card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  host.append(card);
  popover = { element: card, entry };
}

function layoutPins(): void {
  layoutScheduled = false;
  for (const entry of pins) {
    if (!entry.element?.isConnected) {
      entry.element = resolveAnchor(entry.comment.anchor);
    }
    if (!entry.element) {
      entry.pin.style.display = 'none';
      continue;
    }
    const rect = entry.element.getBoundingClientRect();
    const x = Math.round(rect.left + window.scrollX - 8);
    const y = Math.round(rect.top + window.scrollY - 8);
    entry.pin.style.display = 'flex';
    entry.pin.dataset.x = String(x);
    entry.pin.dataset.y = String(y);
    entry.pin.style.transform = `translate(${x}px, ${y}px)`;
  }
}

function scheduleLayout(): void {
  if (layoutScheduled || pins.length === 0) return;
  layoutScheduled = true;
  requestAnimationFrame(layoutPins);
}

function rebuildPins(): void {
  const host = ensureLayer();
  if (!host) return;
  host.replaceChildren();
  popover = null;
  pins = [];
  comments.forEach((comment, index) => {
    const element = resolveAnchor(comment.anchor);
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.textContent = String(index + 1);
    pin.title = `${comment.author}: ${comment.excerpt}`;
    Object.assign(pin.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '18px',
      height: '18px',
      borderRadius: '50% 50% 50% 2px',
      border: 'none',
      background: '#1f6feb',
      color: '#ffffff',
      font: '600 11px/18px -apple-system, "Segoe UI", sans-serif',
      textAlign: 'center',
      cursor: 'pointer',
      display: element ? 'flex' : 'none',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
      pointerEvents: 'auto',
      padding: '0',
    } satisfies Partial<CSSStyleDeclaration>);
    const entry: PinEntry = { comment, label: index + 1, element, pin };
    pin.addEventListener('click', (event) => {
      event.stopPropagation();
      if (popover?.entry.comment.id === comment.id) {
        closePopover();
      } else {
        openPopover(entry);
      }
    });
    host.append(pin);
    pins.push(entry);
  });
  scheduleLayout();
  if (pendingFocusId) focusAnchor(pendingFocusId);
  debugLog('annotations', 'pins-rebuilt', {
    comments: comments.length,
    resolved: pins.filter((entry) => entry.element).length,
  });
}

function focusAnchor(id: string): void {
  const comment = comments.find((entry) => entry.id === id);
  if (!comment || !document.body) {
    pendingFocusId = id;
    return;
  }
  const element = resolveAnchor(comment.anchor);
  if (!element) {
    pendingFocusId = id;
    return;
  }
  pendingFocusId = null;
  appliedFocusId = id;
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const htmlElement = element as HTMLElement;
  const previousOutline = htmlElement.style.outline;
  const previousTransition = htmlElement.style.transition;
  htmlElement.style.transition = 'outline-color 0.4s ease';
  htmlElement.style.outline = '3px solid #1f6feb';
  globalThis.setTimeout(() => {
    htmlElement.style.outline = previousOutline;
    globalThis.setTimeout(() => {
      htmlElement.style.transition = previousTransition;
    }, 500);
  }, 8000);
  post({ kind: ANCHOR_FOCUSED_MESSAGE, id });
}

function ensureProposeButton(): HTMLButtonElement | null {
  if (proposeButton?.isConnected) return proposeButton;
  const host = ensureLayer();
  if (!host) return null;
  proposeButton = document.createElement('button');
  proposeButton.type = 'button';
  proposeButton.textContent = 'Comment';
  Object.assign(proposeButton.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    display: 'none',
    background: '#1f6feb',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    padding: '4px 10px',
    font: '600 12px/1.4 -apple-system, "Segoe UI", sans-serif',
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
    pointerEvents: 'auto',
    zIndex: '2147483646',
  } satisfies Partial<CSSStyleDeclaration>);
  proposeButton.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  proposeButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    proposeSelection();
  });
  host.append(proposeButton);
  return proposeButton;
}

function proposeSelection(): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return;
  }
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  let element: Element =
    container.nodeType === 3
      ? ((container as Text).parentElement ?? document.body)
      : (container as Element);
  while (
    element.parentElement &&
    element !== document.body &&
    !BLOCK_TAGS[element.tagName]
  ) {
    element = element.parentElement;
  }
  const quote = selection.toString().trim().slice(0, 160);
  let anchor: PreviewAnchor;
  if (quote.length >= 3) {
    const prefix = range.cloneRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    anchor = {
      kind: 'text-range',
      css: cssPath(element),
      quote,
      start,
      end: start + range.toString().length,
    };
  } else {
    anchor = { kind: 'element', css: cssPath(element) };
  }
  post({ kind: ANCHOR_PROPOSE_MESSAGE, anchor });
  proposeButton?.style.setProperty('display', 'none');
  selection.removeAllRanges();
}

function onMouseUp(): void {
  globalThis.setTimeout(() => {
    const selection = window.getSelection();
    if (
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0 ||
      !selection.toString().trim()
    ) {
      return;
    }
    const button = ensureProposeButton();
    if (!button) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!Number.isFinite(rect.left)) return;
    const x = Math.round(rect.right + window.scrollX + 4);
    const y = Math.round(rect.top + window.scrollY - 34);
    button.style.display = 'block';
    button.style.transform = `translate(${x}px, ${Math.max(0, y)}px)`;
  }, 0);
}

function onMouseDown(event: MouseEvent): void {
  if (popover && !popover.element.contains(event.target as Node)) {
    closePopover();
  }
  if (
    proposeButton &&
    event.target !== proposeButton &&
    !proposeButton.contains(event.target as Node)
  ) {
    proposeButton.style.display = 'none';
  }
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closePopover();
}

function onMessage(event: MessageEvent<unknown>): void {
  if (event.source !== parent) return;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || data.channel !== channel) return;
  if (data.kind === ANCHORS_MESSAGE && Array.isArray(data.anchors)) {
    const next = data.anchors as AnchoredComment[];
    // Rebuilding wipes open popovers; skip when nothing actually changed.
    const signature = JSON.stringify(
      next.map((comment) => [comment.id, comment.excerpt, comment.author]),
    );
    if (signature !== anchorsSignature) {
      anchorsSignature = signature;
      comments = next;
      rebuildPins();
    } else if (pendingFocusId) {
      focusAnchor(pendingFocusId);
    }
    return;
  }
  if (data.kind === ANCHOR_FOCUS_MESSAGE && typeof data.id === 'string') {
    if (data.id === appliedFocusId) return;
    focusAnchor(data.id);
  }
}

export function installAnnotations(nextChannel: string): void {
  channel = nextChannel;
  // document.open()/write() during render wipes window listeners; this
  // function is re-invoked after each render, so remove before adding to
  // avoid duplicate handlers.
  window.removeEventListener('message', onMessage);
  window.removeEventListener('mouseup', onMouseUp, true);
  window.removeEventListener('mousedown', onMouseDown, true);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('scroll', scheduleLayout, true);
  window.removeEventListener('resize', scheduleLayout);
  window.addEventListener('message', onMessage);
  window.addEventListener('mouseup', onMouseUp, true);
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', scheduleLayout, true);
  window.addEventListener('resize', scheduleLayout);
}

export function notifyAnnotationsRendered(): void {
  layer = null;
  proposeButton = null;
  appliedFocusId = null;
  if (channel) installAnnotations(channel);
  rebuildPins();
  post({ kind: ANCHORS_REQUEST_MESSAGE });
}
