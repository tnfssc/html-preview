import type { ResolveResult } from './types';

export interface RenderResult {
  iframe: HTMLIFrameElement;
  destroy: () => void;
}

export interface RenderOptions {
  height?: string;
  title?: string;
}

export function renderStaticPreview(
  container: HTMLElement,
  result: ResolveResult,
  options?: RenderOptions,
): RenderResult {
  const iframe = document.createElement('iframe');
  iframe.srcdoc = result.html;
  iframe.title = options?.title ?? 'Static HTML preview';
  iframe.referrerPolicy = 'no-referrer';
  iframe.setAttribute('sandbox', '');
  iframe.style.width = '100%';
  iframe.style.height = options?.height ?? '100%';
  iframe.style.display = 'block';
  iframe.style.border = 'none';
  iframe.style.minHeight = '0';
  container.replaceChildren(iframe);

  return {
    iframe,
    destroy: () => {
      iframe.srcdoc = '';
      iframe.remove();
    },
  };
}
