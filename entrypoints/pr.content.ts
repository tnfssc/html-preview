import {
  fetchRepositoryFile,
  parseBlobUrl,
  parsePrFilesUrl,
  type PrFilesRoute,
} from '@/utils/github';
import {
  comparisonPreferencesStorage,
  enabledStorage,
  githubTokenStorage,
  type ComparisonPreferences,
} from '@/utils/storage';
import { resolveHtml } from '@/utils/resolveHtml';
import {
  renderExecutablePreview,
  type RenderResult,
  type ScrollPosition,
} from '@/utils/renderer';
import type { RepoRef } from '@/utils/types';
import { debugError, debugLog } from '@/utils/debug';
import { recordResolveMetrics } from '@/utils/metrics';

const PREVIEW_LINK_CLASS = 'gh-html-preview-pr-link';
const PREVIEW_CONTROLS_CLASS = 'gh-html-preview-pr-controls';
const RICH_CONTAINER_CLASS = 'gh-html-preview-pr-rich';
const DASHBOARD_CLASS = 'gh-html-preview-pr-dashboard';
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

interface PullFileInfo {
  filename: string;
  previousFilename: string | null;
  status: string;
}

interface PrRouteState {
  readonly key: string;
  readonly route: PrFilesRoute;
  readonly controller: AbortController;
  metadata: Promise<PullComparison> | null;
  fileMetadata: Promise<PullFileInfo[]> | null;
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
  readonly syncLabel: HTMLLabelElement;
  readonly viewportSelect: HTMLSelectElement;
  readonly reloadButton: HTMLButtonElement;
  readonly fullscreenButton: HTMLButtonElement;
  readonly effectiveWidth: HTMLElement;
  readonly overlayLabel: HTMLLabelElement;
  readonly overlayInput: HTMLInputElement;
  readonly overlayOpacity: HTMLInputElement;
  readonly resizeObserver: ResizeObserver;
  readonly fullscreenCleanup: () => void;
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
    let preferences: ComparisonPreferences = {
      mode: 'source',
      viewport: 'responsive',
      syncScroll: true,
    };
    let state: PrRouteState | null = null;
    let renderTimer: number | null = null;

    const clearControls = () => {
      for (const rich of state?.richDiffs ?? []) {
        rich.controller?.abort();
        rich.baseRender?.destroy();
        rich.headRender?.destroy();
        rich.resizeObserver.disconnect();
        rich.fullscreenCleanup();
        rich.target.fileContent.style.removeProperty('display');
        rich.container.remove();
      }
      document
        .querySelectorAll(
          `.${PREVIEW_LINK_CLASS}, .${PREVIEW_CONTROLS_CLASS}, .${RICH_CONTAINER_CLASS}, .${DASHBOARD_CLASS}`,
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
          preferences,
        );
      }
      renderHtmlDashboard(targets);
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
          fileMetadata: null,
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
      comparisonPreferencesStorage.getValue(),
    ]).then(([storedEnabled, storedToken, storedPreferences]) => {
      enabled = storedEnabled;
      githubToken = storedToken;
      preferences = storedPreferences;
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

function renderHtmlDashboard(targets: DiffTarget[]): void {
  if (document.querySelector(`.${DASHBOARD_CLASS}`) || targets.length === 0) {
    return;
  }
  const dashboard = document.createElement('nav');
  dashboard.className = DASHBOARD_CLASS;
  dashboard.setAttribute('aria-label', 'HTML files in this pull request');
  dashboard.style.cssText =
    'margin:12px 0;padding:12px;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;background:var(--bgColor-muted,#f6f8fa);';
  const heading = document.createElement('strong');
  heading.textContent = `${targets.length} changed HTML ${targets.length === 1 ? 'file' : 'files'}`;
  const list = document.createElement('ul');
  for (const target of targets) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-link';
    button.textContent = target.path;
    button.addEventListener('click', () => {
      target.file.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.header
        .querySelector<HTMLButtonElement>(`[role="tab"]`)
        ?.focus();
    });
    item.append(button);
    list.append(item);
  }
  dashboard.append(heading, list);
  targets[0].file.before(dashboard);
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
  preferences: ComparisonPreferences,
): void {
  debugLog('pr', 'controls-insert', {
    path: target.path,
    privateRepo: initialHead?.privateRepo ?? false,
  });
  const controls = document.createElement('div');
  controls.className = `${PREVIEW_CONTROLS_CLASS} BtnGroup d-inline-flex`;
  controls.style.cssText = 'display:inline-flex;flex-shrink:0;';
  controls.setAttribute('role', 'tablist');
  controls.setAttribute('aria-label', 'HTML change view');

  const sourceButton = createTextDiffButton('Code diff', 'Display code diff');
  sourceButton.classList.add('selected');
  sourceButton.setAttribute('aria-selected', 'true');
  const splitButton = createTextDiffButton(
    'Before & after',
    'Display before and after previews',
  );
  const afterButton = createTextDiffButton(
    'After preview',
    'Display after preview',
  );
  const modeId = crypto.randomUUID();
  for (const [button, suffix] of [
    [sourceButton, 'source'],
    [splitButton, 'split'],
    [afterButton, 'after'],
  ] as const) {
    button.id = `gh-html-preview-${modeId}-${suffix}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', button === sourceButton ? 'true' : 'false');
  }
  controls.append(sourceButton, splitButton, afterButton);

  const link = document.createElement('a');
  link.className = `${PREVIEW_LINK_CLASS} btn btn-sm ml-2`;
  link.textContent = 'Open after preview';
  link.setAttribute('aria-label', `Open after preview for ${target.path} in new tab`);
  link.title = 'Open after preview in new tab';
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
  container.id = `gh-html-preview-${modeId}-panel`;
  container.className = RICH_CONTAINER_CLASS;
  container.setAttribute('role', 'tabpanel');
  container.setAttribute('aria-labelledby', splitButton.id);
  for (const button of [sourceButton, splitButton, afterButton]) {
    button.setAttribute('aria-controls', container.id);
  }
  sourceButton.tabIndex = 0;
  controls.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [sourceButton, splitButton, afterButton];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[next].focus();
    buttons[next].click();
  });
  container.style.cssText =
    'display:none;flex-direction:column;height:calc(100dvh - 160px);min-height:500px;border-top:1px solid var(--borderColor-default,#d1d9e0);background:var(--bgColor-default,#fff);';
  const header = document.createElement('div');
  header.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 10px;border-bottom:1px solid var(--borderColor-default,#d1d9e0);background:var(--bgColor-muted,#f6f8fa);';
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.style.cssText =
    'color:var(--fgColor-muted,#59636e);font-size:12px;font-weight:600;';
  status.textContent = 'Choose Before & after or After preview';
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
  const viewportSelect = document.createElement('select');
  viewportSelect.setAttribute('aria-label', 'Preview viewport width');
  viewportSelect.className = 'form-select select-sm';
  for (const [value, text] of [
    ['responsive', 'Fit'],
    ['1280', 'Desktop · 1280 px'],
    ['768', 'Tablet · 768 px'],
    ['390', 'Mobile · 390 px'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    viewportSelect.appendChild(option);
  }
  viewportSelect.value = preferences.viewport;
  const syncLabel = document.createElement('label');
  syncLabel.style.cssText =
    'display:inline-flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap;';
  const syncInput = document.createElement('input');
  syncInput.type = 'checkbox';
  syncInput.checked = preferences.syncScroll;
  syncInput.setAttribute('aria-label', 'Synchronize preview scrolling');
  syncLabel.append(syncInput, document.createTextNode('Sync scroll'));
  const reloadButton = createToolbarButton('Reload previews');
  const fullscreenButton = createToolbarButton('Full screen');
  fullscreenButton.setAttribute('aria-pressed', 'false');
  const overlayLabel = document.createElement('label');
  overlayLabel.style.cssText =
    'display:inline-flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap;';
  const overlayInput = document.createElement('input');
  overlayInput.type = 'checkbox';
  overlayInput.setAttribute('aria-label', 'Overlay before and after previews');
  overlayLabel.append(overlayInput, document.createTextNode('Overlay'));
  const overlayOpacity = document.createElement('input');
  overlayOpacity.type = 'range';
  overlayOpacity.min = '0';
  overlayOpacity.max = '100';
  overlayOpacity.value = '50';
  overlayOpacity.setAttribute('aria-label', 'After preview overlay opacity');
  overlayOpacity.style.display = 'none';
  const captureButton = createToolbarButton('Capture screenshot');
  const layoutStatus = document.createElement('span');
  layoutStatus.setAttribute('aria-live', 'polite');
  const effectiveWidth = document.createElement('span');
  effectiveWidth.setAttribute('aria-live', 'polite');
  toolbar.append(
    viewportSelect,
    syncLabel,
    reloadButton,
    fullscreenButton,
    overlayLabel,
    overlayOpacity,
    captureButton,
    effectiveWidth,
    layoutStatus,
  );
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
    const stacked =
      entry.contentRect.width < 900 && base.pane.style.display !== 'none';
    comparisonArea.style.gridTemplateColumns = stacked
      ? 'minmax(0,1fr)'
      : base.pane.style.display === 'none'
        ? 'minmax(0,1fr)'
        : 'minmax(0,1fr) minmax(0,1fr)';
    comparisonArea.style.gridTemplateRows = stacked
      ? 'minmax(500px,1fr) minmax(500px,1fr)'
      : 'minmax(0,1fr)';
    comparisonArea.style.overflowY = stacked ? 'auto' : 'hidden';
    layoutStatus.textContent = stacked ? 'Stacked layout' : '';
  });
  resizeObserver.observe(container);

  const handleFullscreenChange = () => {
    const active = document.fullscreenElement === container;
    fullscreenButton.textContent = active ? 'Exit full screen' : 'Full screen';
    fullscreenButton.setAttribute('aria-pressed', active ? 'true' : 'false');
  };
  document.addEventListener('fullscreenchange', handleFullscreenChange);

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
    syncLabel,
    viewportSelect,
    reloadButton,
    fullscreenButton,
    effectiveWidth,
    overlayLabel,
    overlayInput,
    overlayOpacity,
    resizeObserver,
    fullscreenCleanup: () =>
      document.removeEventListener('fullscreenchange', handleFullscreenChange),
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

  sourceButton.addEventListener('click', () => {
    showSourceDiff(richState);
    void saveComparisonPreferences(richState);
  });
  splitButton.addEventListener('click', () => {
    void comparisonPreferencesStorage.setValue({
      mode: 'split',
      viewport: richState.viewportSelect.value as ComparisonPreferences['viewport'],
      syncScroll: richState.syncInput.checked,
    });
    showRenderedDiff(richState, 'split');
    startRender(richState, githubToken, routeState, false);
  });
  afterButton.addEventListener('click', () => {
    void comparisonPreferencesStorage.setValue({
      mode: 'after',
      viewport: richState.viewportSelect.value as ComparisonPreferences['viewport'],
      syncScroll: richState.syncInput.checked,
    });
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
    void saveComparisonPreferences(richState);
  });
  syncInput.addEventListener('change', () => {
    void saveComparisonPreferences(richState);
  });
  const applyOverlay = () => {
    const active = overlayInput.checked && richState.mode === 'split';
    overlayOpacity.style.display = active ? 'inline-block' : 'none';
    comparisonArea.style.position = active ? 'relative' : '';
    head.pane.style.position = active ? 'absolute' : '';
    head.pane.style.inset = active ? '0' : '';
    head.pane.style.opacity = active
      ? String(Number(overlayOpacity.value) / 100)
      : '';
    head.pane.style.zIndex = active ? '2' : '';
  };
  overlayInput.addEventListener('change', applyOverlay);
  overlayOpacity.addEventListener('input', applyOverlay);
  captureButton.addEventListener('click', () => {
    void captureComparisonScreenshot(
      target.path,
      richState.container,
    ).catch((error: unknown) => {
      status.textContent =
        error instanceof Error
          ? `Screenshot failed: ${error.message}`
          : 'Screenshot failed.';
      status.setAttribute('role', 'alert');
    });
  });
  fullscreenButton.addEventListener('click', () => {
    const action =
      document.fullscreenElement === richState.container
        ? document.exitFullscreen()
        : richState.container.requestFullscreen();
    void action.catch((error: unknown) => {
      richState.status.textContent =
        error instanceof Error
          ? `Full screen failed: ${error.message}`
          : 'Full screen failed.';
      richState.status.setAttribute('role', 'alert');
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
  if (preferences.mode === 'split') {
    queueMicrotask(() => splitButton.click());
  } else if (preferences.mode === 'after') {
    queueMicrotask(() => afterButton.click());
  }
}

async function saveComparisonPreferences(
  state: RichDiffState,
): Promise<void> {
  await comparisonPreferencesStorage.setValue({
    mode: state.mode,
    viewport:
      state.viewportSelect.value as ComparisonPreferences['viewport'],
    syncScroll: state.syncInput.checked,
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
  state.syncLabel.style.display = mode === 'split' ? 'inline-flex' : 'none';
  state.overlayLabel.style.display = mode === 'split' ? 'inline-flex' : 'none';
  if (mode !== 'split') {
    state.overlayInput.checked = false;
    state.overlayOpacity.style.display = 'none';
    state.comparisonArea.style.position = '';
    state.headPane.style.position = '';
    state.headPane.style.inset = '';
    state.headPane.style.opacity = '';
    state.headPane.style.zIndex = '';
  }
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
  state.reloadButton.disabled = true;
  state.reloadButton.setAttribute('aria-disabled', 'true');
  state.reloadButton.textContent = 'Reloading…';
  state.resolving = renderRichComparison(
    state,
    githubToken,
    routeState,
    force,
  ).finally(() => {
    state.resolving = null;
    state.reloadButton.disabled = false;
    state.reloadButton.removeAttribute('aria-disabled');
    state.reloadButton.textContent = 'Reload previews';
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
          routeState,
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
          routeState,
          githubToken,
          controller.signal,
        ),
      );
    }
    await Promise.all(jobs);
    controller.signal.throwIfAborted();
    applyViewportWidth(state);
    const baseAvailable = state.mode !== 'split' || state.baseRender !== null;
    const headAvailable = state.headRender !== null;
    state.status.textContent =
      !baseAvailable && !headAvailable
        ? 'Error: No rendered version is available'
        : baseAvailable && headAvailable
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
  routeState: PrRouteState,
  githubToken: string | null,
  signal: AbortSignal,
): Promise<boolean> {
  const area = sideName === 'base' ? state.baseArea : state.headArea;
  const label = sideName === 'base' ? state.baseLabel : state.headLabel;
  label.textContent = `${sideName === 'base' ? 'Before' : 'After'} · ${side.sha.slice(0, 12)}`;
  try {
    if (side.privateRepo && !githubToken) {
      throw new Error('Private repository access requires a saved GitHub token.');
    }
    let path = state.target.path;
    let repoRef = sideRepoRef(side, path);
    let file;
    try {
      file = await fetchRepositoryFile(repoRef, signal, {
        token: githubToken,
        privateRepo: side.privateRepo,
      });
    } catch (initialError) {
      const info = await getPullFileInfo(
        routeState,
        state.target.path,
        githubToken,
      );
      if (
        sideName === 'base' &&
        info?.status === 'renamed' &&
        info.previousFilename
      ) {
        path = info.previousFilename;
        repoRef = sideRepoRef(side, path);
        label.textContent = `Before · ${side.sha.slice(0, 12)} · ${path}`;
        file = await fetchRepositoryFile(repoRef, signal, {
          token: githubToken,
          privateRepo: side.privateRepo,
        });
      } else if (sideName === 'base' && info?.status === 'added') {
        throw new Error('File was added in this pull request; no Before version exists.');
      } else if (sideName === 'head' && info?.status === 'removed') {
        throw new Error('File was deleted in this pull request; no After version exists.');
      } else {
        throw initialError;
      }
    }
    const privateRepo = side.privateRepo || file.authenticated;
    const result = await resolveHtml(file.text, {
      target: privateRepo ? 'sandbox-private' : 'sandbox',
      repoRef,
      githubToken,
      privateRepo,
      signal,
    });
    signal.throwIfAborted();
    recordResolveMetrics(
      result.performance.resolveMs,
      result.performance.outputBytes,
    );
    appendSideActions(label, side, path);
    appendResourceInspector(label, result);
    if (result.diagnostics.length > 0) {
      const issues = document.createElement('details');
      issues.style.display = 'inline-block';
      issues.style.marginInlineStart = '8px';
      const summary = document.createElement('summary');
      summary.textContent = `${result.diagnostics.length} resource issues`;
      const list = document.createElement('ul');
      for (const diagnostic of result.diagnostics) {
        const item = document.createElement('li');
        item.textContent = diagnostic.url
          ? `${diagnostic.url}: ${diagnostic.message}`
          : diagnostic.message;
        list.append(item);
      }
      const copy = createToolbarButton('Copy diagnostics');
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText(
          result.diagnostics
            .map((diagnostic) =>
              diagnostic.url
                ? `${diagnostic.code} ${diagnostic.url}: ${diagnostic.message}`
                : `${diagnostic.code}: ${diagnostic.message}`,
            )
            .join('\n'),
        );
      });
      issues.append(summary, list, copy);
      label.append(issues);
    }
    const onScroll = (position: ScrollPosition) => {
      if (!state.syncInput.checked) return;
      if (sideName === 'base') state.headRender?.setScroll(position);
      else state.baseRender?.setScroll(position);
    };
    const render = renderExecutablePreview(area, result, {
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

function appendSideActions(
  label: HTMLElement,
  side: PullSide,
  path: string,
): void {
  const previewUrl = buildPreviewPageUrl(
    sideRepoRef(side, path),
    side.privateRepo,
  );
  const sourcePath = path.split('/').map(encodeURIComponent).join('/');
  const sourceUrl = `https://github.com/${encodeURIComponent(side.owner)}/${encodeURIComponent(side.repo)}/blob/${encodeURIComponent(side.sha)}/${sourcePath}`;
  const open = document.createElement('a');
  open.href = previewUrl;
  open.target = '_blank';
  open.rel = 'noreferrer';
  open.textContent = 'Open preview';
  open.style.marginInlineStart = '8px';
  const source = document.createElement('a');
  source.href = sourceUrl;
  source.target = '_blank';
  source.rel = 'noreferrer';
  source.textContent = 'View source';
  source.style.marginInlineStart = '8px';
  const copy = createToolbarButton('Copy preview URL');
  copy.style.marginInlineStart = '8px';
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(previewUrl);
  });
  label.append(open, source, copy);
}

function appendResourceInspector(
  label: HTMLElement,
  result: Awaited<ReturnType<typeof resolveHtml>>,
): void {
  const documentNode = new DOMParser().parseFromString(result.html, 'text/html');
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
        // Resolver diagnostics report malformed URLs.
      }
    }
  }
  const inspector = document.createElement('details');
  inspector.style.display = 'inline-block';
  inspector.style.marginInlineStart = '8px';
  const summary = document.createElement('summary');
  summary.textContent = 'Resources';
  const stats = document.createElement('p');
  stats.textContent = `${result.resources.fetched} fetched · ${result.resources.inlined} packaged · ${result.resources.bytes} bytes`;
  const network = document.createElement('p');
  network.textContent =
    origins.size > 0
      ? `External network origins: ${Array.from(origins).join(', ')}`
      : 'No external network origins declared';
  inspector.append(summary, stats, network);
  label.append(inspector);
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

async function getPullFileInfo(
  routeState: PrRouteState,
  path: string,
  githubToken: string | null,
): Promise<PullFileInfo | null> {
  routeState.fileMetadata ??= fetchPullFiles(
    routeState.route,
    routeState.controller.signal,
    githubToken,
  );
  const files = await routeState.fileMetadata;
  return (
    files.find(
      (file) =>
        file.filename === path || file.previousFilename === path,
    ) ?? null
  );
}

async function fetchPullFiles(
  route: PrFilesRoute,
  signal: AbortSignal,
  githubToken: string | null,
): Promise<PullFileInfo[]> {
  const url = `https://api.github.com/repos/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}/pulls/${route.pullNumber}/files?per_page=100`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  const response = await fetch(url, {
    signal,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers,
  });
  if (!response.ok) {
    throw new Error(`GitHub PR files API returned HTTP ${response.status}.`);
  }
  const data = (await response.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error('GitHub PR files API returned invalid file metadata.');
  }
  return data.flatMap((value): PullFileInfo[] => {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      return [];
    }
    const record = value as Record<string, unknown>;
    if (typeof record.filename !== 'string' || typeof record.status !== 'string') {
      return [];
    }
    return [
      {
        filename: record.filename,
        previousFilename:
          typeof record.previous_filename === 'string'
            ? record.previous_filename
            : null,
        status: record.status,
      },
    ];
  });
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
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.tabIndex = active ? 0 : -1;
  }
  state.container.setAttribute('aria-labelledby', selected.id);
}

function applyViewportWidth(state: RichDiffState): void {
  const value = state.viewportSelect.value;
  const width = value === 'responsive' ? '100%' : `${value}px`;
  for (const area of [state.baseArea, state.headArea]) {
    area.style.width = `min(100%, ${width})`;
    area.style.marginInline = 'auto';
  }
  requestAnimationFrame(() => {
    const visibleArea =
      state.mode === 'after' ? state.headArea : state.baseArea;
    state.effectiveWidth.textContent = `Effective width · ${Math.round(visibleArea.getBoundingClientRect().width)} px`;
  });
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

async function captureComparisonScreenshot(
  path: string,
  comparison: HTMLElement,
): Promise<void> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Screen capture is unavailable in this browser.');
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      await new Promise<void>((resolve) => {
        video.addEventListener('loadedmetadata', () => resolve(), {
          once: true,
        });
      });
    }
    const bounds = comparison.getBoundingClientRect();
    const scaleX = video.videoWidth / window.innerWidth;
    const scaleY = video.videoHeight / window.innerHeight;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bounds.width * scaleX));
    canvas.height = Math.max(1, Math.round(bounds.height * scaleY));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create screenshot canvas.');
    context.drawImage(
      video,
      bounds.left * scaleX,
      bounds.top * scaleY,
      bounds.width * scaleX,
      bounds.height * scaleY,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error('Could not encode screenshot.'));
      }, 'image/png');
    });
    const url = URL.createObjectURL(blob);
    const download = document.createElement('a');
    download.href = url;
    download.download = `${path.split('/').pop() ?? 'html-comparison'}.png`;
    download.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
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
  button.tabIndex = -1;
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
