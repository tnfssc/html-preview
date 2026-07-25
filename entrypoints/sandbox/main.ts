import {
  SANDBOX_READY,
  isSandboxRenderMessage,
} from '@/utils/sandboxProtocol';
import { debugLog } from '@/utils/debug';
import {
  installAnnotations,
  notifyAnnotationsRendered,
} from '@/entrypoints/sandbox/annotations';

const parameters = new URLSearchParams(location.hash.slice(1));
const channel = parameters.get('channel');
const instance = crypto.randomUUID();

if (!channel) {
  document.body.textContent = 'Invalid preview handshake.';
} else {
  installAnnotations(channel);
  let attempts = 0;
  let chunks: string[] | null = null;
  let received = 0;
  const announce = () => {
    attempts += 1;
    parent.postMessage({ kind: SANDBOX_READY, channel, instance }, '*');
    if (attempts === 1) debugLog('sandbox', 'ready-announced');
    if (attempts >= 40) window.clearInterval(announceTimer);
  };
  const announceTimer = window.setInterval(announce, 250);

  const receivePreview = (event: MessageEvent<unknown>) => {
    if (
      event.source !== parent ||
      !isSandboxRenderMessage(event.data) ||
      event.data.channel !== channel
    ) {
      return;
    }
    if (!chunks || chunks.length !== event.data.total) {
      chunks = new Array<string>(event.data.total);
      received = 0;
    }
    if (chunks[event.data.index] === undefined) {
      chunks[event.data.index] = event.data.chunk;
      received += 1;
    }
    if (received !== chunks.length) return;
    window.removeEventListener('message', receivePreview);
    window.clearInterval(announceTimer);
    const html = chunks.join('');
    debugLog('sandbox', 'render-received', {
      htmlBytes: html.length,
      chunks: chunks.length,
    });
    document.open();
    document.write(html);
    document.close();
    notifyAnnotationsRendered();
  };
  window.addEventListener('message', receivePreview);
  announce();
}
