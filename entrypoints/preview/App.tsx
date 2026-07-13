import { useEffect, useRef, useState } from 'react';
import { fetchRepositoryFile } from '@/utils/github';
import { resolveHtml } from '@/utils/resolveHtml';
import { githubTokenStorage } from '@/utils/storage';
import {
  isSandboxReadyMessage,
  postSandboxDocument,
} from '@/utils/sandboxProtocol';
import type { RepoRef, ResolveResult } from '@/utils/types';
import { debugError, debugLog } from '@/utils/debug';
import { recordResolveMetrics } from '@/utils/metrics';

interface LoadState {
  kind: 'loading' | 'ready' | 'partial' | 'error';
  result?: ResolveResult;
  message: string;
}

interface PreviewRequest {
  repoRef: RepoRef;
  privateRepo: boolean;
}

function parseRepoRef(): PreviewRequest | null {
  const params = new URLSearchParams(window.location.search);
  const owner = params.get('owner');
  const repo = params.get('repo');
  const ref = params.get('ref');
  const path = params.get('path');
  if (!owner || !repo || !ref || !path) return null;
  if (
    owner.includes('/') ||
    repo.includes('/') ||
    /[\u0000-\u001f]/.test(`${owner}${repo}${ref}${path}`) ||
    path.startsWith('/') ||
    path.split('/').some((segment) => !segment || segment === '..')
  ) {
    return null;
  }
  return {
    repoRef: { owner, repo, ref, path },
    privateRepo: params.get('private') === '1',
  };
}

function buildGitHubUrl(repoRef: RepoRef): string {
  const path = repoRef.path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(repoRef.repo)}/blob/${encodeURIComponent(repoRef.ref)}/${path}`;
}

export default function App(): React.JSX.Element {
  const [request] = useState(parseRepoRef);
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<LoadState>({
    kind: 'loading',
    message: 'Fetching repository file…',
  });

  useEffect(() => {
    if (!request) {
      setState({
        kind: 'error',
        message: 'Missing or invalid owner, repository, ref, or path.',
      });
      return;
    }
    const controller = new AbortController();
    const { repoRef } = request;

    void (async () => {
      try {
        const githubToken = await githubTokenStorage.getValue();
        debugLog('preview', 'load-start', {
          owner: repoRef.owner,
          repo: repoRef.repo,
          ref: repoRef.ref.slice(0, 12),
          path: repoRef.path,
          privateRepo: request.privateRepo,
          tokenConfigured: Boolean(githubToken),
        });
        if (request.privateRepo && !githubToken) {
          throw new Error(
            'Save a fine-grained GitHub token in the extension popup to open this private file.',
          );
        }
        const file = await fetchRepositoryFile(repoRef, controller.signal, {
          token: githubToken,
          privateRepo: request.privateRepo,
        });
        const privateRepo = request.privateRepo || file.authenticated;
        setState({ kind: 'loading', message: 'Resolving repository URLs…' });
        const result = await resolveHtml(file.text, {
          target: privateRepo ? 'sandbox-private' : 'sandbox',
          repoRef,
          githubToken,
          privateRepo,
          signal: controller.signal,
        });
        const partial = result.diagnostics.some(
          (diagnostic) => diagnostic.level === 'error',
        );
        recordResolveMetrics(
          result.performance.resolveMs,
          result.performance.outputBytes,
        );
        setState({
          kind: partial ? 'partial' : 'ready',
          result,
          message: partial
            ? 'Preview loaded with resource diagnostics.'
            : 'Executable preview ready.',
        });
        debugLog('preview', 'load-complete', {
          path: repoRef.path,
          privateRepo,
          fetched: result.resources.fetched,
          inlined: result.resources.inlined,
          failed: result.resources.failed,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        debugError('preview', 'load-failed', error, {
          path: repoRef.path,
          privateRepo: request.privateRepo,
        });
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Preview failed.',
        });
      }
    })();

    return () => controller.abort();
  }, [request, retryKey]);

  if (!request) {
    return <main className="error">Error: {state.message}</main>;
  }
  const { repoRef } = request;

  return (
    <main>
      <header>
        <h1>
          Preview:{' '}
          <a href={buildGitHubUrl(repoRef)} target="_blank" rel="noreferrer">
            {repoRef.owner}/{repoRef.repo}/{repoRef.path}
          </a>
        </h1>
        <span className="meta">
          Commit {repoRef.ref.slice(0, 12)} · Executable · Scripts and network
          access on{request.privateRepo ? ' · Private' : ''}
        </span>
        <button type="button" onClick={() => setRetryKey((value) => value + 1)}>
          Reload
        </button>
      </header>
      <div
        className={`preview-status preview-status-${state.kind}`}
        role={state.kind === 'error' ? 'alert' : 'status'}
      >
        {state.message}
      </div>
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
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard.writeText(
                state.result?.diagnostics
                  .map((diagnostic) =>
                    diagnostic.url
                      ? `${diagnostic.code} ${diagnostic.url}: ${diagnostic.message}`
                      : `${diagnostic.code}: ${diagnostic.message}`,
                  )
                  .join('\n') ?? '',
              )
            }
          >
            Copy diagnostics
          </button>
        </details>
      )}
      {state.result ? (
        <SandboxFrame html={state.result.html} />
      ) : state.kind === 'error' ? (
        <div className="error">
          <p>Preview unavailable. {state.message}</p>
          <button type="button" onClick={() => setRetryKey((value) => value + 1)}>
            Retry
          </button>
          {request.privateRepo && (
            <a
              href={(browser.runtime.getURL as (path: string) => string)(
                '/popup.html',
              )}
              target="_blank"
              rel="noreferrer"
            >
              Open extension settings
            </a>
          )}
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
      {handshakeError && <div className="error">{handshakeError}</div>}
      <div ref={hostRef} className="preview-host" />
    </>
  );
}

