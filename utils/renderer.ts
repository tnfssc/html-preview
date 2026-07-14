import type { ResolveResult } from './types';
import {
  isSandboxReadyMessage,
  postSandboxDocument,
} from './sandboxProtocol';
import { debugLog } from './debug';
import { recordRenderMetrics } from './metrics';

export interface RenderResult {
  iframe: HTMLIFrameElement;
  setScroll: (position: ScrollPosition) => void;
  destroy: () => void;
}

export interface ScrollPosition {
  x: number;
  y: number;
  anchor?: ScrollAnchor;
}

export interface ScrollAnchor {
  key: string;
  nextKey: string | null;
  progress: number;
  offset: number;
}

export interface RenderOptions {
  height?: string;
  title?: string;
  onScroll?: (position: ScrollPosition) => void;
}

export function renderExecutablePreview(
  container: HTMLElement,
  result: ResolveResult,
  options?: RenderOptions,
): RenderResult {
  const startedAt = performance.now();
  const iframe = document.createElement('iframe');
  const channel = crypto.randomUUID();
  iframe.title = options?.title ?? 'Executable HTML preview';
  iframe.referrerPolicy = 'no-referrer';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.width = '100%';
  iframe.style.height = options?.height ?? '100%';
  iframe.style.display = 'block';
  iframe.style.border = 'none';
  iframe.style.minHeight = '0';
  container.replaceChildren(iframe);
  const htmlReady = options?.onScroll
    ? installScrollBridge(result.html, channel).catch(() => result.html)
    : Promise.resolve(result.html);
  let renderSent = false;
  iframe.src = (browser.runtime.getURL as (path: string) => string)(
    `/sandbox.html#${new URLSearchParams({ channel }).toString()}`,
  );

  const receiveScroll = (event: MessageEvent<unknown>) => {

    if (
      event.source !== iframe.contentWindow ||
      typeof event.data !== 'object' ||
      event.data === null ||
      Array.isArray(event.data)
    ) {
      return;
    }
    const data = event.data as Record<string, unknown>;
    if (
      isSandboxReadyMessage(data) &&
      data.channel === channel &&
      !renderSent
    ) {
      renderSent = true;
      void htmlReady.then((html) => {
        if (iframe.contentWindow) {
          postSandboxDocument(iframe.contentWindow, channel, html);
        }
        const handshakeMs = performance.now() - startedAt;
        debugLog('renderer', 'sandbox-render-sent', {
          outputBytes: result.performance.outputBytes,
          handshakeMs: Math.round(handshakeMs),
        });
        recordRenderMetrics(handshakeMs);
      });
      return;
    }
    if (
      data.kind === 'gh-html-preview-scroll' &&
      data.channel === channel &&
      typeof data.x === 'number' &&
      typeof data.y === 'number'
    ) {
      options?.onScroll?.({
        x: clampRatio(data.x),
        y: clampRatio(data.y),
        anchor: parseScrollAnchor(data.anchor),
      });
    }
  };
  window.addEventListener('message', receiveScroll);

  return {
    iframe,
    setScroll: (position) => {
      iframe.contentWindow?.postMessage(
        {
          kind: 'gh-html-preview-set-scroll',
          channel,
          x: clampRatio(position.x),
          y: clampRatio(position.y),
          anchor: position.anchor,
        },
        '*',
      );
    },
    destroy: () => {
      window.removeEventListener('message', receiveScroll);
      iframe.src = 'about:blank';
      iframe.remove();
    },
  };
}

async function installScrollBridge(
  html: string,
  channel: string,
): Promise<string> {
  const documentNode = new DOMParser().parseFromString(html, 'text/html');
  const csp = documentNode.querySelector<HTMLMetaElement>(
    'meta[http-equiv="Content-Security-Policy" i]',
  );
  const script = documentNode.createElement('script');
  script.textContent = `(() => {
    const channel = ${JSON.stringify(channel)};
    globalThis.__ghHtmlPreviewScrollBridge = true;
    let applying = false;
    let scheduled = false;
    let anchorsDirty = true;
    let anchors = [];
    let anchorsByKey = new Map();
    const MAX_ANCHORS = 5000;
    const ratio = (value, maximum) => maximum > 0 ? value / maximum : 0;
    const clamp = (value) => Math.min(1, Math.max(0, value));
    const normalizedText = (value) =>
      value.replace(/\\s+/g, ' ').trim().slice(0, 160);
    const buildAnchors = () => {
      const occurrences = new Map();
      const next = [];
      const elements = document.querySelectorAll(
        '[id], a[name], h1, h2, h3, h4, h5, h6',
      );
      for (const element of elements) {
        let baseKey = '';
        if (element.id && document.getElementById(element.id) === element) {
          baseKey = 'id:' + element.id;
        } else if (
          element instanceof HTMLAnchorElement &&
          element.name
        ) {
          baseKey = 'name:' + element.name;
        } else {
          const text = normalizedText(element.textContent || '');
          if (text) baseKey = 'heading:' + element.tagName + ':' + text;
        }
        if (!baseKey) continue;
        const occurrence = occurrences.get(baseKey) || 0;
        occurrences.set(baseKey, occurrence + 1);
        const key = occurrence === 0 ? baseKey : baseKey + '#' + occurrence;
        const top = element.getBoundingClientRect().top + scrollY;
        if (Number.isFinite(top)) next.push({ key, top });
        if (next.length >= MAX_ANCHORS) break;
      }
      next.sort((left, right) => left.top - right.top);
      anchors = next;
      anchorsByKey = new Map(next.map((anchor) => [anchor.key, anchor]));
      anchorsDirty = false;
    };
    const currentAnchors = () => {
      if (anchorsDirty) buildAnchors();
      return anchors;
    };
    const scrollAnchor = () => {
      const list = currentAnchors();
      if (list.length === 0) return undefined;
      let low = 0;
      let high = list.length - 1;
      let index = -1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (list[middle].top <= scrollY) {
          index = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (index < 0) return undefined;
      const anchor = list[index];
      const next = list[index + 1];
      const distance = next ? next.top - anchor.top : 0;
      return {
        key: anchor.key,
        nextKey: next?.key || null,
        progress: distance > 0 ? clamp((scrollY - anchor.top) / distance) : 0,
        offset: scrollY - anchor.top,
      };
    };
    const observer = new MutationObserver(() => { anchorsDirty = true; });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['id', 'name'],
    });
    new ResizeObserver(() => { anchorsDirty = true; })
      .observe(document.documentElement);
    addEventListener('scroll', () => {
      if (applying || scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const root = document.documentElement;
        parent.postMessage({
          kind: 'gh-html-preview-scroll',
          channel,
          x: ratio(scrollX, root.scrollWidth - innerWidth),
          y: ratio(scrollY, root.scrollHeight - innerHeight),
          anchor: scrollAnchor(),
        }, '*');
      });
    }, { passive: true });
    addEventListener('message', (event) => {
      const data = event.data;
      if (
        event.source !== parent ||
        !data ||
        data.kind !== 'gh-html-preview-set-scroll' ||
        data.channel !== channel
      ) return;
      const root = document.documentElement;
      applying = true;
      let top = data.y * Math.max(0, root.scrollHeight - innerHeight);
      const anchor = data.anchor;
      if (
        anchor &&
        typeof anchor.key === 'string' &&
        Number.isFinite(anchor.progress) &&
        Number.isFinite(anchor.offset)
      ) {
        currentAnchors();
        const start = anchorsByKey.get(anchor.key);
        const end =
          typeof anchor.nextKey === 'string'
            ? anchorsByKey.get(anchor.nextKey)
            : undefined;
        if (start && end && end.top > start.top) {
          top = start.top + clamp(anchor.progress) * (end.top - start.top);
        } else if (start) {
          top = start.top + anchor.offset;
        }
      }
      scrollTo(
        data.x * Math.max(0, root.scrollWidth - innerWidth),
        top,
      );
      requestAnimationFrame(() => { applying = false; });
    });
  })();`;
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(script.textContent),
  );
  const hashBase64 = btoa(
    String.fromCharCode(...new Uint8Array(hash)),
  );
  if (csp) {
    csp.content = csp.content.replace(
      "script-src 'none'",
      `script-src 'sha256-${hashBase64}'`,
    );
  }
  documentNode.body.appendChild(script);
  return `<!doctype html>\n${documentNode.documentElement.outerHTML}`;
}

function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function parseScrollAnchor(value: unknown): ScrollAnchor | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const anchor = value as Record<string, unknown>;
  if (
    typeof anchor.key !== 'string' ||
    anchor.key.length === 0 ||
    anchor.key.length > 512 ||
    (anchor.nextKey !== null && typeof anchor.nextKey !== 'string') ||
    typeof anchor.progress !== 'number' ||
    typeof anchor.offset !== 'number' ||
    !Number.isFinite(anchor.offset)
  ) {
    return undefined;
  }
  return {
    key: anchor.key,
    nextKey:
      typeof anchor.nextKey === 'string' && anchor.nextKey.length <= 512
        ? anchor.nextKey
        : null,
    progress: clampRatio(anchor.progress),
    offset: Math.min(10_000_000, Math.max(-10_000_000, anchor.offset)),
  };
}
