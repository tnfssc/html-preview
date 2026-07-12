import { parsePrFilesUrl, type PrFilesRoute } from '@/utils/github';
import { enabledStorage, githubTokenStorage } from '@/utils/storage';
import type { RepoRef } from '@/utils/types';
import { debugError, debugLog } from '@/utils/debug';

const PREVIEW_LINK_CLASS = 'gh-html-preview-pr-link';
const DIFF_SELECTOR =
  '#files .file, [data-testid="diff-file"], [data-testid="diff-file-header"]';

interface PullHead {
  owner: string;
  repo: string;
  sha: string;
  privateRepo: boolean;
}

interface PrRouteState {
  readonly key: string;
  readonly route: PrFilesRoute;
  readonly controller: AbortController;
  readonly metadata: Promise<PullHead>;
}

interface DiffTarget {
  header: HTMLElement;
  path: string;
}

export default defineContentScript({
  matches: ['*://github.com/*'],
  runAt: 'document_end',
  main(ctx) {
    let enabled = true;
    let githubToken: string | null = null;
    let state: PrRouteState | null = null;
    let renderTimer: number | null = null;

    const clearLinks = () => {
      document
        .querySelectorAll(`.${PREVIEW_LINK_CLASS}`)
        .forEach((element) => element.remove());
    };

    const stopRoute = () => {
      state?.controller.abort();
      state = null;
      clearLinks();
      if (renderTimer !== null) {
        window.clearTimeout(renderTimer);
        renderTimer = null;
      }
    };

    const renderCards = async (routeState: PrRouteState) => {
      const targets = findDiffTargets();
      if (targets.length === 0) return;
      try {
        const head = await routeState.metadata;
        routeState.controller.signal.throwIfAborted();
        if (state !== routeState) return;
        for (const target of targets) {
          if (target.header.querySelector(`.${PREVIEW_LINK_CLASS}`)) continue;
          insertPreviewLink(target, head);
        }
        debugLog('pr', 'buttons-rendered', {
          owner: head.owner,
          repo: head.repo,
          privateRepo: head.privateRepo,
          targets: targets.length,
        });
      } catch (error) {
        if (
          !(error instanceof DOMException && error.name === 'AbortError') &&
          !routeState.controller.signal.aborted
        ) {
          debugError('pr', 'metadata-failed', error, {
            owner: routeState.route.owner,
            repo: routeState.route.repo,
            pull: routeState.route.pullNumber,
          });
          console.error('[gh-html-preview] PR metadata request failed:', error);
        }
      }
    };

    const scheduleRender = () => {
      if (!state || renderTimer !== null) return;
      renderTimer = window.setTimeout(() => {
        renderTimer = null;
        if (state) void renderCards(state);
      }, 80);
    };

    const reconcileRoute = () => {
      const route = enabled ? parsePrFilesUrl(location.href) : null;
      if (!route) {
        stopRoute();
        return;
      }
      const key = `${route.owner}/${route.repo}#${route.pullNumber}`;
      if (state?.key !== key) {
        stopRoute();
        const controller = new AbortController();
        state = {
          key,
          route: Object.freeze({ ...route }),
          controller,
          metadata: fetchPullHead(route, controller.signal, githubToken),
        };
      }
      scheduleRender();
    };

    const observer = new MutationObserver((mutations) => {
      if (!state) return;
      const relevant = mutations.some((mutation) =>
        Array.from(mutation.addedNodes).some(
          (node) =>
            node instanceof Element &&
            (node.matches(DIFF_SELECTOR) || node.querySelector(DIFF_SELECTOR)),
        ),
      );
      if (relevant) scheduleRender();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    ctx.addEventListener(window, 'wxt:locationchange', reconcileRoute);
    const unwatchEnabled = enabledStorage.watch((next) => {
      enabled = next;
      reconcileRoute();
    });
    const unwatchToken = githubTokenStorage.watch((next) => {
      githubToken = next;
      stopRoute();
      reconcileRoute();
    });
    void Promise.all([
      enabledStorage.getValue(),
      githubTokenStorage.getValue(),
    ]).then(([storedEnabled, storedToken]) => {
      enabled = storedEnabled;
      githubToken = storedToken;
      reconcileRoute();
    });

    ctx.onInvalidated(() => {
      observer.disconnect();
      unwatchEnabled();
      unwatchToken();
      stopRoute();
    });
  },
});

async function fetchPullHead(
  route: PrFilesRoute,
  signal: AbortSignal,
  githubToken: string | null,
): Promise<PullHead> {
  const url = `https://api.github.com/repos/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}/pulls/${route.pullNumber}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  debugLog('pr', 'metadata-fetch', {
    owner: route.owner,
    repo: route.repo,
    pull: route.pullNumber,
    tokenConfigured: Boolean(githubToken),
  });
  const response = await fetch(url, {
    signal,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers,
  });
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);

  const data = (await response.json()) as unknown;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('GitHub API returned invalid PR metadata.');
  }
  const head = (data as Record<string, unknown>).head;
  if (typeof head !== 'object' || head === null || Array.isArray(head)) {
    throw new Error('PR head metadata is missing.');
  }
  const headRecord = head as Record<string, unknown>;
  const sha = headRecord.sha;
  const repoValue = headRecord.repo;
  if (
    typeof sha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(sha) ||
    typeof repoValue !== 'object' ||
    repoValue === null ||
    Array.isArray(repoValue)
  ) {
    throw new Error('PR head repository or SHA is invalid.');
  }
  const fullName = (repoValue as Record<string, unknown>).full_name;
  if (typeof fullName !== 'string') {
    throw new Error('PR head repository name is missing.');
  }
  const match = /^([^/]+)\/([^/]+)$/.exec(fullName);
  if (!match) throw new Error('PR head repository name is malformed.');
  return {
    owner: match[1],
    repo: match[2],
    sha,
    privateRepo: (repoValue as Record<string, unknown>).private === true,
  };
}

function findDiffTargets(): DiffTarget[] {
  const targets: DiffTarget[] = [];
  const seen = new Set<HTMLElement>();

  for (const file of Array.from(
    document.querySelectorAll<HTMLElement>('#files .file'),
  )) {
    const header = file.querySelector<HTMLElement>('.file-header');
    const path =
      file.dataset.path ??
      header?.dataset.path ??
      header?.querySelector<HTMLElement>('.file-info a[title]')?.getAttribute('title');
    if (header && validHtmlPath(path) && !seen.has(header)) {
      seen.add(header);
      targets.push({ header, path });
    }
  }

  for (const header of Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="diff-file-header"], [data-testid="file-header"]',
    ),
  )) {
    const card = header.closest<HTMLElement>('[data-testid="diff-file"]');
    const pathElement = header.querySelector<HTMLElement>('[data-path]');
    const path = card?.dataset.path ?? header.dataset.path ?? pathElement?.dataset.path;
    if (validHtmlPath(path) && !seen.has(header)) {
      seen.add(header);
      targets.push({ header, path });
    }
  }
  return targets;
}

function validHtmlPath(path: string | null | undefined): path is string {
  if (!path || path.length > 4096 || path.startsWith('/')) return false;
  const segments = path.split('/');
  return (
    segments.every((segment) => segment.length > 0 && segment !== '..') &&
    /\.html?$/i.test(path)
  );
}

function insertPreviewLink(target: DiffTarget, head: PullHead): void {
  const link = document.createElement('a');
  link.className = PREVIEW_LINK_CLASS;
  link.textContent = 'Preview';
  link.setAttribute('aria-label', `Open full preview for ${target.path}`);
  link.href = buildPreviewPageUrl({
    owner: head.owner,
    repo: head.repo,
    ref: head.sha,
    path: target.path,
  }, head.privateRepo);
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.style.cssText =
    'margin-left:8px;padding:4px 8px;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;background:var(--bgColor-muted,#f6f8fa);color:var(--fgColor-default,#1f2328);font-size:12px;font-weight:600;text-decoration:none;cursor:pointer;';
  const actions = target.header.querySelector<HTMLElement>(
    '.file-actions, [data-testid="file-header-actions"]',
  );
  (actions ?? target.header).appendChild(link);
}

function buildPreviewPageUrl(repoRef: RepoRef, privateRepo: boolean): string {
  const params = new URLSearchParams({
    owner: repoRef.owner,
    repo: repoRef.repo,
    ref: repoRef.ref,
    path: repoRef.path,
    ...(privateRepo ? { private: '1' } : {}),
  });
  return browser.runtime.getURL(`/preview.html?${params.toString()}`);
}
