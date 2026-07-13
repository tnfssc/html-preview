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
    const ratio = (value, maximum) => maximum > 0 ? value / maximum : 0;
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
      scrollTo(
        data.x * Math.max(0, root.scrollWidth - innerWidth),
        data.y * Math.max(0, root.scrollHeight - innerHeight),
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
