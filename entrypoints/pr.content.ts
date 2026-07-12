import {
  fetchRepositoryFile,
  parseBlobUrl,
  parsePrFilesUrl,
  type PrFilesRoute,
} from '@/utils/github';
import { enabledStorage, githubTokenStorage } from '@/utils/storage';
import { resolveHtml } from '@/utils/resolveHtml';
import {
  renderStaticPreview,
  type RenderResult,
  type ScrollPosition,
} from '@/utils/renderer';
import type { RepoRef } from '@/utils/types';
import { debugError, debugLog } from '@/utils/debug';

const PREVIEW_LINK_CLASS = 'gh-html-preview-pr-link';
const PREVIEW_CONTROLS_CLASS = 'gh-html-preview-pr-controls';
const RICH_CONTAINER_CLASS = 'gh-html-preview-pr-rich';
const DIFF_SELECTOR =
  '#files .file, [data-testid="diff-file"], [data-testid="diff-file-header"], [data-diff-header-wrapper], [role="region"][id^="diff-"]';

interface PullSide {
  owner: string;
  repo: string;
  sha: string;
  privateRepo: boolean;
}

interface PullComparison {
  base: PullSide;
  head: PullSide;
}

interface PrRouteState {
  readonly key: string;
  readonly route: PrFilesRoute;
  readonly controller: AbortController;
  metadata: Promise<PullComparison> | null;
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
  readonly initialHead: PullSide | null;
  readonly sourceButton: HTMLButtonElement;
  readonly splitButton: HTMLButtonElement;
  readonly afterButton: HTMLButtonElement;
  readonly previewLink: HTMLAnchorElement;
  readonly container: HTMLElement;
  readonly status: HTMLElement;
  readonly comparisonArea: HTMLElement;
  readonly basePane: HTMLElement;
  readonly headPane: HTMLElement;
  readonly baseLabel: HTMLElement;
  readonly headLabel: HTMLElement;
  readonly baseArea: HTMLElement;
  readonly headArea: HTMLElement;
  readonly syncInput: HTMLInputElement;
  readonly viewportSelect: HTMLSelectElement;
  readonly resizeObserver: ResizeObserver;
  controller: AbortController | null;
  baseRender: RenderResult | null;
  headRender: RenderResult | null;
  comparison: PullComparison | null;
  resolving: Promise<void> | null;
  mode: 'source' | 'split' | 'after';
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
        rich.baseRender?.destroy();
        rich.headRender?.destroy();
        rich.resizeObserver.disconnect();
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

    const renderCards = (routeState: PrRouteState) => {
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
      for (const target of targets) {
        if (target.header.querySelector(`.${PREVIEW_CONTROLS_CLASS}`)) continue;
        insertPreviewControls(
          target,
          target.repoRef
            ? {
                owner: target.repoRef.owner,
                repo: target.repoRef.repo,
                sha: target.repoRef.ref,
                privateRepo: false,
              }
            : null,
          githubToken,
          routeState,
        );
      }
      debugLog('pr', 'buttons-rendered', {
        targets: targets.length,
        source: 'dom',
      });
    };

    const scheduleRender = () => {
      if (!state || renderTimer !== null) return;
      renderTimer = window.setTimeout(() => {
        renderTimer = null;
        if (state) renderCards(state);
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

async function fetchPullComparison(
  route: PrFilesRoute,
  signal: AbortSignal,
  githubToken: string | null,
): Promise<PullComparison> {
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
  return {
    base: parsePullSide((data as Record<string, unknown>).base, 'base'),
    head: parsePullSide((data as Record<string, unknown>).head, 'head'),
  };
}

function parsePullSide(value: unknown, label: 'base' | 'head'): PullSide {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`PR ${label} metadata is missing.`);
  }
  const record = value as Record<string, unknown>;
  const sha = record.sha;
  const repoValue = record.repo;
  if (
    typeof sha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(sha) ||
    typeof repoValue !== 'object' ||
    repoValue === null ||
    Array.isArray(repoValue)
  ) {
    throw new Error(`PR ${label} repository or SHA is invalid.`);
  }
  const fullName = (repoValue as Record<string, unknown>).full_name;
  if (typeof fullName !== 'string') {
    throw new Error(`PR ${label} repository name is missing.`);
  }
  const match = /^([^/]+)\/([^/]+)$/.exec(fullName);
  if (!match) throw new Error(`PR ${label} repository name is malformed.`);
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
  initialHead: PullSide | null,
  githubToken: string | null,
  routeState: PrRouteState,
): void {
  debugLog('pr', 'controls-insert', {
    path: target.path,
    privateRepo: initialHead?.privateRepo ?? false,
  });
  const controls = document.createElement('div');
  controls.className = `${PREVIEW_CONTROLS_CLASS} BtnGroup d-inline-flex`;
  controls.style.cssText = 'display:inline-flex;flex-shrink:0;';

  const sourceButton = createTextDiffButton('Source', 'Display the source diff');
  sourceButton.classList.add('selected');
  sourceButton.setAttribute('aria-current', 'true');
  const splitButton = createTextDiffButton(
    'Split',
    'Display synchronized before and after previews',
  );
  const afterButton = createTextDiffButton(
    'After',
    'Display the rendered PR head',
  );
  controls.append(sourceButton, splitButton, afterButton);

  const link = document.createElement('a');
  link.className = `${PREVIEW_LINK_CLASS} btn btn-sm ml-2`;
  link.textContent = 'Preview HTML';
  link.setAttribute('aria-label', `Open full preview for ${target.path}`);
  link.title = 'Open full HTML preview';
  link.href = initialHead
    ? buildPreviewPageUrl(
        sideRepoRef(initialHead, target.path),
        initialHead.privateRepo,
      )
    : '#';
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.style.cssText =
    'display:inline-flex;align-items:center;white-space:nowrap;flex-shrink:0;';

  const container = document.createElement('section');
  container.className = RICH_CONTAINER_CLASS;
  container.setAttribute('aria-label', `Rich HTML diff for ${target.path}`);
  container.style.cssText =
    'display:none;flex-direction:column;height:calc(100dvh - 160px);min-height:500px;border-top:1px solid var(--borderColor-default,#d1d9e0);background:var(--bgColor-default,#fff);';
  const header = document.createElement('div');
  header.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 10px;border-bottom:1px solid var(--borderColor-default,#d1d9e0);background:var(--bgColor-muted,#f6f8fa);';
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.style.cssText =
    'color:var(--fgColor-muted,#59636e);font-size:12px;font-weight:600;';
  status.textContent = 'Choose Split or After';
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
  const viewportSelect = document.createElement('select');
  viewportSelect.setAttribute('aria-label', 'Preview viewport width');
  viewportSelect.className = 'form-select select-sm';
  for (const [value, text] of [
    ['responsive', 'Responsive'],
    ['1280', 'Desktop'],
    ['768', 'Tablet'],
    ['390', 'Mobile'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    viewportSelect.appendChild(option);
  }
  const syncLabel = document.createElement('label');
  syncLabel.style.cssText =
    'display:inline-flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap;';
  const syncInput = document.createElement('input');
  syncInput.type = 'checkbox';
  syncInput.checked = true;
  syncInput.setAttribute('aria-label', 'Synchronize preview scrolling');
  syncLabel.append(syncInput, document.createTextNode('Sync scroll'));
  const reloadButton = createToolbarButton('Reload');
  const fullscreenButton = createToolbarButton('Full screen');
  toolbar.append(viewportSelect, syncLabel, reloadButton, fullscreenButton);
  header.append(status, toolbar);

  const comparisonArea = document.createElement('div');
  comparisonArea.style.cssText =
    'display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);flex:1;min-height:0;overflow:hidden;background:var(--bgColor-muted,#f6f8fa);';
  const base = createComparisonPane('Before');
  const head = createComparisonPane('After');
  comparisonArea.append(base.pane, head.pane);
  container.append(header, comparisonArea);
  target.fileContent.before(container);
  target.actions.prepend(controls, link);

  const resizeObserver = new ResizeObserver(([entry]) => {
    if (!entry) return;
    comparisonArea.style.gridTemplateColumns =
      entry.contentRect.width < 900 || base.pane.style.display === 'none'
        ? 'minmax(0,1fr)'
        : 'minmax(0,1fr) minmax(0,1fr)';
  });
  resizeObserver.observe(container);

  const richState: RichDiffState = {
    target,
    initialHead,
    sourceButton,
    splitButton,
    afterButton,
    previewLink: link,
    container,
    status,
    comparisonArea,
    basePane: base.pane,
    headPane: head.pane,
    baseLabel: base.label,
    headLabel: head.label,
    baseArea: base.area,
    headArea: head.area,
    syncInput,
    viewportSelect,
    resizeObserver,
    controller: null,
    baseRender: null,
    headRender: null,
    comparison: null,
    resolving: null,
    mode: 'source',
  };
  routeState.richDiffs.add(richState);

  if (!initialHead) {
    void getPullComparison(routeState, githubToken)
      .then((comparison) => {
        if (!richState.container.isConnected) return;
        richState.comparison = comparison;
        richState.previewLink.href = buildPreviewPageUrl(
          sideRepoRef(comparison.head, target.path),
          comparison.head.privateRepo,
        );
      })
      .catch((error: unknown) => {
        debugError('pr', 'metadata-background-failed', error, {
          path: target.path,
        });
      });
  }

  sourceButton.addEventListener('click', () => showSourceDiff(richState));
  splitButton.addEventListener('click', () => {
    showRenderedDiff(richState, 'split');
    startRender(richState, githubToken, routeState, false);
  });
  afterButton.addEventListener('click', () => {
    showRenderedDiff(richState, 'after');
    startRender(richState, githubToken, routeState, false);
  });
  reloadButton.addEventListener('click', () => {
    if (richState.mode !== 'source') {
      showRenderedDiff(richState, richState.mode);
      startRender(richState, githubToken, routeState, true);
    }
  });
  viewportSelect.addEventListener('change', () => {
    applyViewportWidth(richState);
  });
  fullscreenButton.addEventListener('click', () => {
    void richState.container.requestFullscreen().catch((error: unknown) => {
      richState.status.textContent =
        error instanceof Error
          ? `Full screen failed: ${error.message}`
          : 'Full screen failed.';
    });
  });
  link.addEventListener('click', (event) => {
    if (richState.initialHead || richState.comparison) return;
    event.preventDefault();
    const pending = window.open('about:blank', '_blank');
    if (pending) pending.opener = null;
    void getPullComparison(routeState, githubToken)
      .then((comparison) => {
        richState.comparison = comparison;
        const url = buildPreviewPageUrl(
          sideRepoRef(comparison.head, target.path),
          comparison.head.privateRepo,
        );
        richState.previewLink.href = url;
        if (pending) pending.location.replace(url);
      })
      .catch((error: unknown) => {
        pending?.close();
        richState.status.textContent =
          error instanceof Error
            ? `Error: ${error.message}`
            : 'Error: PR metadata unavailable.';
      });
  });
}

function showSourceDiff(state: RichDiffState): void {
  state.controller?.abort();
  state.controller = null;
  state.mode = 'source';
  selectModeButton(state, state.sourceButton);
  state.container.style.display = 'none';
  state.target.fileContent.style.removeProperty('display');
}

function showRenderedDiff(
  state: RichDiffState,
  mode: 'split' | 'after',
): void {
  state.mode = mode;
  selectModeButton(
    state,
    mode === 'split' ? state.splitButton : state.afterButton,
  );
  state.basePane.style.display = mode === 'split' ? 'flex' : 'none';
  state.headPane.style.display = 'flex';
  state.comparisonArea.style.gridTemplateColumns =
    mode === 'split' && state.container.clientWidth >= 900
      ? 'minmax(0,1fr) minmax(0,1fr)'
      : 'minmax(0,1fr)';
  state.target.fileContent.style.setProperty('display', 'none', 'important');
  state.container.style.display = 'flex';
}

function startRender(
  state: RichDiffState,
  githubToken: string | null,
  routeState: PrRouteState,
  force: boolean,
): void {
  if (state.resolving) return;
  state.resolving = renderRichComparison(
    state,
    githubToken,
    routeState,
    force,
  ).finally(() => {
    state.resolving = null;
  });
}

async function renderRichComparison(
  state: RichDiffState,
  githubToken: string | null,
  routeState: PrRouteState,
  force: boolean,
): Promise<void> {
  if (force) {
    state.controller?.abort();
    state.baseRender?.destroy();
    state.headRender?.destroy();
    state.baseRender = null;
    state.headRender = null;
    state.comparison = null;
  }
  const controller = new AbortController();
  state.controller = controller;
  const abort = () => controller.abort();
  routeState.controller.signal.addEventListener('abort', abort, { once: true });
  state.status.textContent = 'Loading comparison…';
  debugLog('pr', 'rich-comparison-start', {
    path: state.target.path,
    mode: state.mode,
    tokenConfigured: Boolean(githubToken),
  });
  try {
    const comparison =
      state.comparison ??
      (state.mode === 'after' && state.initialHead
        ? null
        : await getPullComparison(routeState, githubToken));
    if (comparison) {
      state.comparison = comparison;
      state.previewLink.href = buildPreviewPageUrl(
        sideRepoRef(comparison.head, state.target.path),
        comparison.head.privateRepo,
      );
    }
    const head = comparison?.head ?? state.initialHead;
    if (!head) throw new Error('PR head metadata is unavailable.');

    const jobs: Array<Promise<boolean>> = [];
    if (state.mode === 'split' && !state.baseRender) {
      if (!comparison) throw new Error('PR base metadata is unavailable.');
      jobs.push(
        renderComparisonSide(
          state,
          'base',
          comparison.base,
          githubToken,
          controller.signal,
        ),
      );
    }
    if (!state.headRender) {
      jobs.push(
        renderComparisonSide(
          state,
          'head',
          head,
          githubToken,
          controller.signal,
        ),
      );
    }
    const sideResults = await Promise.all(jobs);
    controller.signal.throwIfAborted();
    applyViewportWidth(state);
    state.status.textContent =
      sideResults.length > 0 && !sideResults.some(Boolean)
        ? 'Error: No rendered version is available'
        : sideResults.every(Boolean)
        ? state.mode === 'split'
          ? 'Before and after ready'
          : 'After ready'
        : 'Comparison partial';
    debugLog('pr', 'rich-comparison-complete', {
      path: state.target.path,
      mode: state.mode,
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    state.status.textContent =
      error instanceof Error
        ? `Error: ${error.message}`
        : 'Error: Comparison failed.';
    debugError('pr', 'rich-comparison-failed', error, {
      path: state.target.path,
    });
  } finally {
    routeState.controller.signal.removeEventListener('abort', abort);
    if (state.controller === controller) state.controller = null;
  }
}

async function renderComparisonSide(
  state: RichDiffState,
  sideName: 'base' | 'head',
  side: PullSide,
  githubToken: string | null,
  signal: AbortSignal,
): Promise<boolean> {
  const repoRef = sideRepoRef(side, state.target.path);
  const area = sideName === 'base' ? state.baseArea : state.headArea;
  const label = sideName === 'base' ? state.baseLabel : state.headLabel;
  label.textContent = `${sideName === 'base' ? 'Before' : 'After'} · ${side.sha.slice(0, 12)}`;
  try {
    if (side.privateRepo && !githubToken) {
      throw new Error('Private repository access requires a saved GitHub token.');
    }
    const file = await fetchRepositoryFile(repoRef, signal, {
      token: githubToken,
      privateRepo: side.privateRepo,
    });
    const privateRepo = side.privateRepo || file.authenticated;
    const result = await resolveHtml(file.text, {
      target: privateRepo ? 'sandbox-private' : 'sandbox',
      repoRef,
      githubToken,
      privateRepo,
      signal,
    });
    signal.throwIfAborted();
    const onScroll = (position: ScrollPosition) => {
      if (!state.syncInput.checked) return;
      if (sideName === 'base') state.headRender?.setScroll(position);
      else state.baseRender?.setScroll(position);
    };
    const render = renderStaticPreview(area, result, {
      title: `${sideName === 'base' ? 'Before' : 'After'} HTML preview for ${state.target.path}`,
      onScroll,
    });
    if (sideName === 'base') {
      state.baseRender?.destroy();
      state.baseRender = render;
    } else {
      state.headRender?.destroy();
      state.headRender = render;
    }
    return true;
  } catch (error) {
    if (signal.aborted) throw error;
    area.replaceChildren(
      createSideMessage(
        sideName === 'base'
          ? 'Base version unavailable. File may have been added.'
          : 'Head version unavailable. File may have been deleted.',
        error,
      ),
    );
    debugError('pr', `${sideName}-preview-failed`, error, {
      path: state.target.path,
      ref: side.sha.slice(0, 12),
    });
    return false;
  }
}

async function getPullComparison(
  routeState: PrRouteState,
  githubToken: string | null,
): Promise<PullComparison> {
  routeState.metadata ??= fetchPullComparison(
    routeState.route,
    routeState.controller.signal,
    githubToken,
  ).catch((error: unknown) => {
    routeState.metadata = null;
    throw error;
  });
  return routeState.metadata;
}

function selectModeButton(
  state: RichDiffState,
  selected: HTMLButtonElement,
): void {
  for (const button of [
    state.sourceButton,
    state.splitButton,
    state.afterButton,
  ]) {
    const active = button === selected;
    button.classList.toggle('selected', active);
    if (active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
}

function applyViewportWidth(state: RichDiffState): void {
  const value = state.viewportSelect.value;
  const width = value === 'responsive' ? '100%' : `${value}px`;
  for (const area of [state.baseArea, state.headArea]) {
    area.style.width = `min(100%, ${width})`;
    area.style.marginInline = 'auto';
  }
}

function createComparisonPane(labelText: string): {
  pane: HTMLElement;
  label: HTMLElement;
  area: HTMLElement;
} {
  const pane = document.createElement('section');
  pane.style.cssText =
    'display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;border-right:1px solid var(--borderColor-default,#d1d9e0);';
  const label = document.createElement('div');
  label.style.cssText =
    'padding:5px 8px;background:var(--bgColor-muted,#f6f8fa);border-bottom:1px solid var(--borderColor-default,#d1d9e0);font-size:12px;font-weight:600;';
  label.textContent = labelText;
  const area = document.createElement('div');
  area.style.cssText =
    'flex:1;min-height:0;overflow:hidden;background:var(--bgColor-default,#fff);';
  pane.append(label, area);
  return { pane, label, area };
}

function createToolbarButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm';
  button.textContent = label;
  return button;
}

function createTextDiffButton(
  text: string,
  label: string,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm BtnGroup-item';
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

function createSideMessage(message: string, error: unknown): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.style.cssText =
    'display:grid;place-content:center;height:100%;padding:24px;color:var(--fgColor-muted,#59636e);text-align:center;';
  const detail = error instanceof Error ? error.message : String(error);
  wrapper.textContent = `${message} ${detail}`;
  return wrapper;
}

function sideRepoRef(side: PullSide, path: string): RepoRef {
  return {
    owner: side.owner,
    repo: side.repo,
    ref: side.sha,
    path,
  };
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
