import { useEffect, useRef, useState } from 'react';
import {
  isSandboxReadyMessage,
  postSandboxDocument,
} from '@/utils/sandboxProtocol';
import type { RepoRef, ResolveResult } from '@/utils/types';
import { debugError, debugLog } from '@/utils/debug';
import {
  loadPreviewSnapshot,
  type PreviewSnapshot,
} from '@/utils/previewSnapshot';

interface LoadState {
  kind: 'loading' | 'ready' | 'partial' | 'error';
  result?: ResolveResult;
  snapshot?: PreviewSnapshot;
  message: string;
}

function parseSnapshotId(): string | null {
  const params = new URLSearchParams(window.location.search);
  const snapshot = params.get('snapshot');
  return snapshot && /^[0-9a-f-]{36}$/i.test(snapshot) ? snapshot : null;
}

function buildGitHubUrl(repoRef: RepoRef): string {
  const path = repoRef.path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(repoRef.repo)}/blob/${encodeURIComponent(repoRef.ref)}/${path}`;
}

export default function App(): React.JSX.Element {
  const [snapshotId] = useState(parseSnapshotId);
  const [state, setState] = useState<LoadState>(
    snapshotId
      ? { kind: 'loading', message: 'Loading packaged preview…' }
      : {
          kind: 'error',
          message: 'Missing or invalid preview snapshot.',
        },
  );
  const [copyError, setCopyError] = useState(false);

  useEffect(() => {
    if (!snapshotId) {
      setState({
        kind: 'error',
        message: 'Missing or invalid preview snapshot.',
      });
      return;
    }
    void (async () => {
      try {
        const snapshot = await loadPreviewSnapshot(snapshotId);
        if (!snapshot) {
          throw new Error(
            'Preview snapshot expired. Return to GitHub and open full preview again.',
          );
        }
        const { result, repoRef, privateRepo } = snapshot;
        const partial = result.diagnostics.some(
          (diagnostic) => diagnostic.level === 'error',
        );
        setState({
          kind: partial ? 'partial' : 'ready',
          result,
          snapshot,
          message: partial
            ? 'Preview loaded with resource diagnostics.'
            : '',
        });
        debugLog('preview', 'load-complete', {
          path: repoRef.path,
          privateRepo,
          fetched: result.resources.fetched,
          inlined: result.resources.inlined,
          failed: result.resources.failed,
        });
      } catch (error) {
        debugError('preview', 'load-failed', error);
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Preview failed.',
        });
      }
    })();
  }, [snapshotId]);

  const handleCopyDiagnostics = async () => {
    const text =
      state.result?.diagnostics
        .map((diagnostic) =>
          diagnostic.url
            ? `${diagnostic.code} ${diagnostic.url}: ${diagnostic.message}`
            : `${diagnostic.code}: ${diagnostic.message}`,
        )
        .join('\n') ?? '';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setCopyError(true);
      window.setTimeout(() => setCopyError(false), 2000);
    }
  };

  if (!snapshotId) {
    return <main className="error">Error: {state.message}</main>;
  }
  const repoRef = state.snapshot?.repoRef;

  return (
    <main>
      <header>
        <h1>
          Preview:{' '}
          {repoRef ? (
            <a href={buildGitHubUrl(repoRef)} target="_blank" rel="noreferrer">
              {repoRef.owner}/{repoRef.repo}/{repoRef.path}
            </a>
          ) : (
            'Loading'
          )}
        </h1>
        {repoRef && (
          <span className="meta">
            Commit {repoRef.ref.slice(0, 12)} · Executable · Scripts and network
            access on{state.snapshot?.privateRepo ? ' · Private' : ''}
          </span>
        )}
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </header>
      {state.message && (
        <div
          className={`preview-status preview-status-${state.kind}`}
          role={state.kind === 'error' ? 'alert' : 'status'}
        >
          {state.message}
        </div>
      )}
      {state.result && (
        <details className="diagnostics">
          <summary>Resources and network</summary>
          <p>
            {state.result.resources.fetched} fetched ·{' '}
            {state.result.resources.inlined} packaged ·{' '}
            {state.result.performance.outputBytes} output bytes ·{' '}
            {Math.round(state.result.performance.resolveMs)} ms
          </p>
          <p>{describeExternalOrigins(state.result.html)}</p>
        </details>
      )}
      {state.result && state.result.diagnostics.length > 0 && (
        <details className="diagnostics">
          <summary>
            View {state.result.diagnostics.length} resource issues
          </summary>
          <ul>
            {state.result.diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.code}-${diagnostic.url ?? ''}-${index}`}>
                {diagnostic.url ? `${diagnostic.url}: ` : ''}
                {diagnostic.message}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => void handleCopyDiagnostics()}>
            {copyError ? 'Copy failed' : 'Copy diagnostics'}
          </button>
        </details>
      )}
      {state.result ? (
        <SandboxFrame html={state.result.html} />
      ) : state.kind === 'error' ? (
        <div className="error">
          <p>Preview unavailable. {state.message}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      ) : (
        <div className="loading">{state.message}</div>
      )}
    </main>
  );
}

function describeExternalOrigins(html: string): string {
  const documentNode = new DOMParser().parseFromString(html, 'text/html');
  const origins = new Set<string>();
  for (const element of Array.from(
    documentNode.querySelectorAll('[src], [href], [action]'),
  )) {
    for (const attribute of ['src', 'href', 'action']) {
      const value = element.getAttribute(attribute);
      if (!value || !/^https?:/i.test(value)) continue;
      try {
        origins.add(new URL(value).origin);
      } catch {
        // Resolver diagnostics represent malformed URLs.
      }
    }
  }
  return origins.size > 0
    ? `External network origins: ${Array.from(origins).join(', ')}`
    : 'No external network origins declared';
}

function SandboxFrame({ html }: { html: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [handshakeError, setHandshakeError] = useState<string | null>(null);

  useEffect(() => {
    setHandshakeError(null);
    const host = hostRef.current;
    if (!host) return;
    const channelBytes = crypto.getRandomValues(new Uint8Array(16));
    const channel = Array.from(channelBytes, (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const iframe = document.createElement('iframe');
    iframe.className = 'preview-frame';
    iframe.title = 'Executable HTML preview';
    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-modals allow-popups allow-downloads',
    );

    let completed = false;
    const receiveReady = (event: MessageEvent<unknown>) => {
      if (
        event.source !== iframe.contentWindow ||
        event.origin !== 'null' ||
        !isSandboxReadyMessage(event.data) ||
        event.data.channel !== channel ||
        completed
      ) {
        return;
      }
      completed = true;
      debugLog('preview', 'sandbox-ready', { htmlBytes: html.length });
      if (iframe.contentWindow) {
        postSandboxDocument(iframe.contentWindow, channel, html);
      }
    };
    window.addEventListener('message', receiveReady);
    iframe.src = (browser.runtime.getURL as (path: string) => string)(
      `/sandbox.html#${new URLSearchParams({ channel }).toString()}`,
    );
    host.replaceChildren(iframe);

    const timeout = window.setTimeout(() => {
      if (!completed) {
        const error = new Error('Sandbox did not accept preview content.');
        debugError('preview', 'sandbox-timeout', error);
        setHandshakeError(error.message);
      }
    }, 10_000);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('message', receiveReady);
      iframe.src = 'about:blank';
      iframe.remove();
    };
  }, [html]);

  return (
    <>
      {handshakeError && (
        <div className="error" role="alert">
          {handshakeError}
        </div>
      )}
      <div ref={hostRef} className="preview-host" />
    </>
  );
}

