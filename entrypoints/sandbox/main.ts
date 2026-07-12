import {
  SANDBOX_READY,
  isSandboxRenderMessage,
} from '@/utils/sandboxProtocol';
import { debugLog } from '@/utils/debug';

const parameters = new URLSearchParams(location.hash.slice(1));
const channel = parameters.get('channel');

if (!channel) {
  document.body.textContent = 'Invalid preview handshake.';
} else {
  let attempts = 0;
  const announce = () => {
    attempts += 1;
    parent.postMessage({ kind: SANDBOX_READY, channel }, '*');
    if (attempts === 1) debugLog('sandbox', 'ready-announced');
    if (attempts >= 40) window.clearInterval(announceTimer);
  };
  const announceTimer = window.setInterval(announce, 250);

  const receivePreview = (event: MessageEvent<unknown>) => {
    if (
      event.source !== parent ||
      !event.origin.startsWith('chrome-extension://') ||
      !isSandboxRenderMessage(event.data) ||
      event.data.channel !== channel
    ) {
      return;
    }
    window.removeEventListener('message', receivePreview);
    window.clearInterval(announceTimer);
    debugLog('sandbox', 'render-received', {
      htmlBytes: event.data.html.length,
    });
    document.open();
    document.write(event.data.html);
    document.close();
  };
  window.addEventListener('message', receivePreview);
  announce();
}
