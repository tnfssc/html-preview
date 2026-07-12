import type { ResolveResult } from './types';

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

export function renderStaticPreview(
  container: HTMLElement,
  result: ResolveResult,
  options?: RenderOptions,
): RenderResult {
  const iframe = document.createElement('iframe');
  const channel = options?.onScroll ? crypto.randomUUID() : null;
  iframe.srcdoc = channel
    ? '<!doctype html><html><body>Loading comparison…</body></html>'
    : result.html;
  iframe.title = options?.title ?? 'Static HTML preview';
  iframe.referrerPolicy = 'no-referrer';
  iframe.setAttribute('sandbox', channel ? 'allow-scripts' : '');
  iframe.style.width = '100%';
  iframe.style.height = options?.height ?? '100%';
  iframe.style.display = 'block';
  iframe.style.border = 'none';
  iframe.style.minHeight = '0';
  container.replaceChildren(iframe);
  if (channel) {
    void installScrollBridge(result.html, channel)
      .then((html) => {
        if (iframe.isConnected) iframe.srcdoc = html;
      })
      .catch(() => {
        if (iframe.isConnected) iframe.srcdoc = result.html;
      });
  }

  const receiveScroll = (event: MessageEvent<unknown>) => {
    if (
      !channel ||
      event.source !== iframe.contentWindow ||
      typeof event.data !== 'object' ||
      event.data === null ||
      Array.isArray(event.data)
    ) {
      return;
    }
    const data = event.data as Record<string, unknown>;
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
  if (channel) window.addEventListener('message', receiveScroll);

  return {
    iframe,
    setScroll: (position) => {
      if (!channel) return;
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
      iframe.srcdoc = '';
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
