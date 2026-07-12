import { useEffect, useRef, useState } from 'react';
import { fetchPublicFile } from '@/utils/github';
import { resolveHtml } from '@/utils/resolveHtml';
import {
  SANDBOX_RENDER,
  isSandboxReadyMessage,
} from '@/utils/sandboxProtocol';
import type { RepoRef, ResolveResult } from '@/utils/types';

interface LoadState {
  kind: 'loading' | 'ready' | 'partial' | 'error';
  result?: ResolveResult;
  message: string;
}

function parseRepoRef(): RepoRef | null {
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
  return { owner, repo, ref, path };
}

function buildGitHubUrl(repoRef: RepoRef): string {
  const path = repoRef.path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(repoRef.repo)}/blob/${encodeURIComponent(repoRef.ref)}/${path}`;
}

export default function App(): React.JSX.Element {
  const [repoRef] = useState(parseRepoRef);
  const [state, setState] = useState<LoadState>({
    kind: 'loading',
    message: 'Fetching public repository file…',
  });

  useEffect(() => {
    if (!repoRef) {
      setState({
        kind: 'error',
        message: 'Missing or invalid owner, repository, ref, or path.',
      });
      return;
    }
    const controller = new AbortController();

    void (async () => {
      try {
        const html = await fetchPublicFile(repoRef, controller.signal);
        setState({ kind: 'loading', message: 'Resolving repository URLs…' });
        const result = await resolveHtml(html, {
          target: 'sandbox',
          repoRef,
          signal: controller.signal,
        });
        const partial = result.diagnostics.some(
          (diagnostic) => diagnostic.level === 'error',
        );
        setState({
          kind: partial ? 'partial' : 'ready',
          result,
          message: partial
            ? 'Preview loaded with resource diagnostics.'
            : 'Executable preview ready.',
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Preview failed.',
        });
      }
    })();

    return () => controller.abort();
  }, [repoRef]);

  if (!repoRef) {
    return <main className="error">Error: {state.message}</main>;
  }

  return (
    <main>
      <header>
        <h1>
          Preview:{' '}
          <a href={buildGitHubUrl(repoRef)} target="_blank" rel="noreferrer">
            {repoRef.owner}/{repoRef.repo}/{repoRef.path}
          </a>
        </h1>
        <span className="meta">ref: {repoRef.ref.slice(0, 12)}</span>
      </header>
      <div className={`preview-status preview-status-${state.kind}`} role="status">
        {state.message}
      </div>
      {state.result ? (
        <SandboxFrame html={state.result.html} />
      ) : state.kind === 'error' ? (
        <div className="error">Preview unavailable. {state.message}</div>
      ) : (
        <div className="loading">{state.message}</div>
      )}
    </main>
  );
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
      iframe.contentWindow?.postMessage(
        { kind: SANDBOX_RENDER, channel, html },
        '*',
      );
    };
    window.addEventListener('message', receiveReady);
    iframe.src = (browser.runtime.getURL as (path: string) => string)(
      `/sandbox.html#${new URLSearchParams({ channel }).toString()}`,
    );
    host.replaceChildren(iframe);

    const timeout = window.setTimeout(() => {
      if (!completed) setHandshakeError('Sandbox did not accept preview content.');
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

