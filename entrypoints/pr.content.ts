import {
  fetchRepositoryFile,
  parseBlobUrl,
  parsePrFilesUrl,
  type PrFilesRoute,
} from '@/utils/github';
import { enabledStorage, githubTokenStorage } from '@/utils/storage';
import { resolveHtml } from '@/utils/resolveHtml';
import { renderStaticPreview, type RenderResult } from '@/utils/renderer';
import type { RepoRef } from '@/utils/types';
import { debugError, debugLog } from '@/utils/debug';

const PREVIEW_LINK_CLASS = 'gh-html-preview-pr-link';
const PREVIEW_CONTROLS_CLASS = 'gh-html-preview-pr-controls';
const RICH_CONTAINER_CLASS = 'gh-html-preview-pr-rich';
const DIFF_SELECTOR =
  '#files .file, [data-testid="diff-file"], [data-testid="diff-file-header"], [data-diff-header-wrapper], [role="region"][id^="diff-"]';

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
  metadata: Promise<PullHead> | null;
  readonly richDiffs: Set<RichDiffState>;
}

interface DiffTarget {
  file: HTMLElement;
  header: HTMLElement;
  fileContent: HTMLElement;
  actions: HTMLElement;
  path: string;
  repoRef: RepoRef | null;
}

interface RichDiffState {
  readonly target: DiffTarget;
  readonly sourceButton: HTMLButtonElement;
  readonly richButton: HTMLButtonElement;
  readonly container: HTMLElement;
  readonly status: HTMLElement;
  readonly previewArea: HTMLElement;
  controller: AbortController | null;
  render: RenderResult | null;
  resolving: Promise<void> | null;
}

export default defineContentScript({
  matches: ['*://github.com/*'],
  runAt: 'document_end',
  main(ctx) {
    debugLog('pr', 'content-script-start', {
      path: location.pathname,
    });
    let enabled = true;
    let githubToken: string | null = null;
    let state: PrRouteState | null = null;
    let renderTimer: number | null = null;

    const clearControls = () => {
      for (const rich of state?.richDiffs ?? []) {
        rich.controller?.abort();
        rich.render?.destroy();
        rich.target.fileContent.style.removeProperty('display');
        rich.container.remove();
      }
      document
        .querySelectorAll(
          `.${PREVIEW_LINK_CLASS}, .${PREVIEW_CONTROLS_CLASS}, .${RICH_CONTAINER_CLASS}`,
        )
        .forEach((element) => element.remove());
    };

    const stopRoute = () => {
      state?.controller.abort();
      clearControls();
      state = null;
      if (renderTimer !== null) {
        window.clearTimeout(renderTimer);
        renderTimer = null;
      }
    };

    const renderCards = async (routeState: PrRouteState) => {
      const targets = findDiffTargets();
      debugLog('pr', 'target-scan', {
        classicCards: document.querySelectorAll('#files .file').length,
        testHeaders: document.querySelectorAll(
          '[data-testid="diff-file-header"], [data-testid="file-header"]',
        ).length,
        reactHeaders: document.querySelectorAll('[data-diff-header-wrapper]')
          .length,
        htmlDataPaths: Array.from(
          document.querySelectorAll<HTMLElement>('[data-path]'),
        ).filter((element) => validHtmlPath(element.dataset.path)).length,
        targets: targets.length,
      });
      if (targets.length === 0) return;
      const unresolved: DiffTarget[] = [];
      for (const target of targets) {
        if (target.header.querySelector(`.${PREVIEW_CONTROLS_CLASS}`)) continue;
        if (target.repoRef) {
          insertPreviewControls(
            target,
            {
              owner: target.repoRef.owner,
              repo: target.repoRef.repo,
              sha: target.repoRef.ref,
              privateRepo: false,
            },
            githubToken,
            routeState,
          );
        } else {
          unresolved.push(target);
        }
      }
      if (unresolved.length === 0) {
        debugLog('pr', 'buttons-rendered', {
          targets: targets.length,
          source: 'view-file-links',
        });
        return;
      }
      try {
        routeState.metadata ??= fetchPullHead(
          routeState.route,
          routeState.controller.signal,
          githubToken,
        );
        const head = await routeState.metadata;
        routeState.controller.signal.throwIfAborted();
        if (state !== routeState) return;
        for (const target of unresolved) {
          if (target.header.querySelector(`.${PREVIEW_CONTROLS_CLASS}`)) continue;
          insertPreviewControls(target, head, githubToken, routeState);
        }
        debugLog('pr', 'buttons-rendered', {
          owner: head.owner,
          repo: head.repo,
          privateRepo: head.privateRepo,
          targets: unresolved.length,
          source: 'pull-api',
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
      debugLog('pr', 'route-reconcile', {
        path: location.pathname,
        enabled,
        matched: Boolean(route),
      });
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
          metadata: null,
          richDiffs: new Set(),
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
    const fileContent = file.querySelector<HTMLElement>('.js-file-content');
    const actions = header?.querySelector<HTMLElement>(
      '.file-actions > .d-flex, .file-actions',
    );
    const path =
      file.dataset.path ??
      header?.dataset.path ??
      header?.querySelector<HTMLElement>('.file-info a[title]')?.getAttribute('title');
    if (
      header &&
      fileContent &&
      actions &&
      validHtmlPath(path) &&
      !seen.has(header)
    ) {
      seen.add(header);
      targets.push({
        file,
        header,
        fileContent,
        actions,
        path,
        repoRef: findViewFileRepoRef(header, path),
      });
    }
  }

  for (const header of Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="diff-file-header"], [data-testid="file-header"]',
    ),
  )) {
    const card = header.closest<HTMLElement>('[data-testid="diff-file"]');
    const fileContent = card?.querySelector<HTMLElement>(
      '[data-testid="diff-file-content"], [data-testid="diff-content"]',
    );
    const actions = header.querySelector<HTMLElement>(
      '[data-testid="file-header-actions"]',
    );
    const pathElement = header.querySelector<HTMLElement>('[data-path]');
    const path = card?.dataset.path ?? header.dataset.path ?? pathElement?.dataset.path;
    if (
      card &&
      fileContent &&
      actions &&
      validHtmlPath(path) &&
      !seen.has(header)
    ) {
      seen.add(header);
      targets.push({
        file: card,
        header,
        fileContent,
        actions,
        path,
        repoRef: findViewFileRepoRef(header, path),
      });
    }
  }

  for (const wrapper of Array.from(
    document.querySelectorAll<HTMLElement>('[data-diff-header-wrapper]'),
  )) {
    const file = wrapper.closest<HTMLElement>('[role="region"][id^="diff-"]');
    const header = wrapper.firstElementChild;
    const table = file?.querySelector<HTMLTableElement>(
      'table[aria-label^="Diff for:"]',
    );
    const fileContent = table?.closest<HTMLElement>(
      '.border, [data-testid="diff-file-content"]',
    );
    const path =
      file
        ?.querySelector<HTMLElement>('[data-file-path]')
        ?.getAttribute('data-file-path') ??
      table?.getAttribute('aria-label')?.replace(/^Diff for:\s*/, '') ??
      null;
    const actions =
      header instanceof HTMLElement && header.lastElementChild instanceof HTMLElement
        ? header.lastElementChild
        : null;
    if (
      file &&
      header instanceof HTMLElement &&
      fileContent &&
      actions &&
      validHtmlPath(path) &&
      !seen.has(header)
    ) {
      seen.add(header);
      targets.push({
        file,
        header,
        fileContent,
        actions,
        path,
        repoRef: findViewFileRepoRef(header, path),
      });
    }
  }
  return targets;
}

function findViewFileRepoRef(
  header: HTMLElement,
  expectedPath: string,
): RepoRef | null {
  for (const link of Array.from(
    header.querySelectorAll<HTMLAnchorElement>('a[href*="/blob/"]'),
  )) {
    const parsed = parseBlobUrl(new URL(link.href, location.href));
    if (
      parsed &&
      parsed.path === expectedPath &&
      /^[0-9a-f]{40}$/i.test(parsed.ref)
    ) {
      return parsed;
    }
  }
  return null;
}

function validHtmlPath(path: string | null | undefined): path is string {
  if (!path || path.length > 4096 || path.startsWith('/')) return false;
  const segments = path.split('/');
  return (
    segments.every((segment) => segment.length > 0 && segment !== '..') &&
    /\.html?$/i.test(path)
  );
}

function insertPreviewControls(
  target: DiffTarget,
  head: PullHead,
  githubToken: string | null,
  routeState: PrRouteState,
): void {
  debugLog('pr', 'controls-insert', {
    path: target.path,
    privateRepo: head.privateRepo,
  });
  const controls = document.createElement('div');
  controls.className = `${PREVIEW_CONTROLS_CLASS} BtnGroup d-inline-flex`;
  controls.style.cssText = 'display:inline-flex;flex-shrink:0;';

  const sourceButton = createDiffButton(
    'Display the source diff',
    'source selected',
    codeIcon(),
  );
  sourceButton.setAttribute('aria-current', 'true');
  const richButton = createDiffButton(
    'Display the rich diff',
    'rendered',
    fileIcon(),
  );
  controls.append(sourceButton, richButton);

  const link = document.createElement('a');
  link.className = `${PREVIEW_LINK_CLASS} btn btn-sm ml-2`;
  link.textContent = 'Preview HTML';
  link.setAttribute('aria-label', `Open full preview for ${target.path}`);
  link.title = 'Open full HTML preview';
  link.href = buildPreviewPageUrl(
    {
      owner: head.owner,
      repo: head.repo,
      ref: head.sha,
      path: target.path,
    },
    head.privateRepo,
  );
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.style.cssText =
    'display:inline-flex;align-items:center;white-space:nowrap;flex-shrink:0;';

  const container = document.createElement('section');
  container.className = RICH_CONTAINER_CLASS;
  container.setAttribute('aria-label', `Rich HTML diff for ${target.path}`);
  container.style.cssText =
    'display:none;flex-direction:column;height:calc(100dvh - 160px);min-height:500px;border-top:1px solid var(--borderColor-default,#d1d9e0);background:var(--bgColor-default,#fff);';
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.style.cssText =
    'padding:8px 12px;border-bottom:1px solid var(--borderColor-default,#d1d9e0);color:var(--fgColor-muted,#59636e);font-size:12px;font-weight:600;';
  status.textContent = 'Ready to render HTML';
  const previewArea = document.createElement('div');
  previewArea.style.cssText = 'flex:1;min-height:0;overflow:hidden;';
  container.append(status, previewArea);
  target.fileContent.before(container);
  target.actions.prepend(controls, link);

  const richState: RichDiffState = {
    target,
    sourceButton,
    richButton,
    container,
    status,
    previewArea,
    controller: null,
    render: null,
    resolving: null,
  };
  routeState.richDiffs.add(richState);

  sourceButton.addEventListener('click', () => showSourceDiff(richState));
  richButton.addEventListener('click', () => {
    showRichDiff(richState);
    if (!richState.render && !richState.resolving) {
      richState.resolving = renderRichDiff(
        richState,
        head,
        githubToken,
        routeState,
      ).finally(() => {
        richState.resolving = null;
      });
    }
  });
}

function showSourceDiff(state: RichDiffState): void {
  state.controller?.abort();
  state.controller = null;
  state.sourceButton.classList.add('selected');
  state.sourceButton.setAttribute('aria-current', 'true');
  state.richButton.classList.remove('selected');
  state.richButton.removeAttribute('aria-current');
  state.container.style.display = 'none';
  state.target.fileContent.style.removeProperty('display');
}

function showRichDiff(state: RichDiffState): void {
  state.sourceButton.classList.remove('selected');
  state.sourceButton.removeAttribute('aria-current');
  state.richButton.classList.add('selected');
  state.richButton.setAttribute('aria-current', 'true');
  state.target.fileContent.style.setProperty('display', 'none', 'important');
  state.container.style.display = 'flex';
}

async function renderRichDiff(
  state: RichDiffState,
  head: PullHead,
  githubToken: string | null,
  routeState: PrRouteState,
): Promise<void> {
  const controller = new AbortController();
  state.controller = controller;
  const abort = () => controller.abort();
  routeState.controller.signal.addEventListener('abort', abort, { once: true });
  state.status.textContent = 'Loading HTML…';
  const repoRef: RepoRef = {
    owner: head.owner,
    repo: head.repo,
    ref: head.sha,
    path: state.target.path,
  };
  debugLog('pr', 'rich-diff-start', {
    owner: head.owner,
    repo: head.repo,
    path: state.target.path,
    privateRepo: head.privateRepo,
    tokenConfigured: Boolean(githubToken),
  });
  try {
    if (head.privateRepo && !githubToken) {
      throw new Error(
        'Save a fine-grained GitHub token in the extension popup to preview this private file.',
      );
    }
    const file = await fetchRepositoryFile(repoRef, controller.signal, {
      token: githubToken,
      privateRepo: head.privateRepo,
    });
    const result = await resolveHtml(file.text, {
      target: 'static',
      repoRef,
      githubToken,
      privateRepo: head.privateRepo || file.authenticated,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    if (!state.container.isConnected || routeState.controller.signal.aborted) return;
    state.render?.destroy();
    state.render = renderStaticPreview(state.previewArea, result, {
      title: `Rich HTML diff for ${state.target.path}`,
    });
    state.status.textContent =
      result.resources.failed > 0 || result.resources.skipped > 0
        ? 'Partial'
        : 'Ready';
    debugLog('pr', 'rich-diff-complete', {
      path: state.target.path,
      fetched: result.resources.fetched,
      inlined: result.resources.inlined,
      failed: result.resources.failed,
      skipped: result.resources.skipped,
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    state.status.textContent =
      error instanceof Error ? `Error: ${error.message}` : 'Error: Preview failed.';
    debugError('pr', 'rich-diff-failed', error, {
      path: state.target.path,
      privateRepo: head.privateRepo,
    });
  } finally {
    routeState.controller.signal.removeEventListener('abort', abort);
    if (state.controller === controller) state.controller = null;
  }
}

function createDiffButton(
  label: string,
  stateClasses: string,
  icon: SVGSVGElement,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn btn-sm BtnGroup-item tooltipped tooltipped-s ${stateClasses}`;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.appendChild(icon);
  return button;
}

function codeIcon(): SVGSVGElement {
  return createIcon(
    'M11.28 3.22 15.53 7.47a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L13.94 8l-3.72-3.72a.75.75 0 0 1 1.06-1.06Zm-6.56 0a.75.75 0 0 1 1.06 1.06L2.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L.47 8.53a.75.75 0 0 1 0-1.06Z',
    'octicon-code',
  );
}

function fileIcon(): SVGSVGElement {
  return createIcon(
    'M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Z',
    'octicon-file',
  );
}

function createIcon(pathData: string, iconClass: string): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('height', '16');
  icon.setAttribute('width', '16');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('class', `octicon ${iconClass}`);
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', pathData);
  icon.appendChild(path);
  return icon;
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
