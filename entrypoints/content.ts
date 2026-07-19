import {
  extractBlobPageData,
  fetchRepositoryFile,
  parseBlobUrl,
} from '@/utils/github';
import { resolveHtml } from '@/utils/resolveHtml';
import { renderExecutablePreview, type RenderResult } from '@/utils/renderer';
import {
  enabledStorage,
  purgeLegacyCredentials,
} from '@/utils/storage';
import type { BlobPageData } from '@/utils/github';
import type { RepoRef, ResolveResult } from '@/utils/types';
import { recordResolveMetrics } from '@/utils/metrics';
import { debugError, debugLog } from '@/utils/debug';
import {
  removePreviewSnapshot,
  savePreviewSnapshot,
} from '@/utils/previewSnapshot';

const PREVIEW_TAB_CLASS = 'gh-html-preview-tab';
const PREVIEW_CONTAINER_CLASS = 'gh-html-preview-container';
const RELEVANT_DOM_SELECTOR =
  '.react-blob-view-header-sticky, ul[class*="SegmentedControl"][aria-label="File view"], .react-code-lines, [data-testid="code-cell"]';

interface RouteState {
  readonly generation: number;
  readonly key: string;
  readonly repoRef: Readonly<RepoRef>;
  readonly sourceHtml: string | null;
  readonly metadataDiagnostic: string | null;
  readonly isPrivate: boolean;
  readonly controller: AbortController;
  readonly tab: HTMLElement;
  readonly tabButton: HTMLButtonElement;
  readonly tabBar: HTMLElement;
  readonly nativeListenerCleanup: Array<() => void>;
  readonly container: HTMLElement;
  readonly previewArea: HTMLElement;
  readonly status: HTMLElement;
  readonly details: HTMLElement;
  readonly fullLink: HTMLAnchorElement;
  codeView: HTMLElement;
  active: boolean;
  render: RenderResult | null;
  resolving: Promise<void> | null;
  snapshotId: string | null;
}

export default defineContentScript({
  matches: ['*://github.com/*'],
  runAt: 'document_end',
  main(ctx) {
    let enabled = true;
    let generation = 0;
    let state: RouteState | null = null;
    let reconcileTimer: number | null = null;
    let lastLocation = location.href;

    const teardown = () => {
      if (state) {
        debugLog('blob', 'teardown', {
          path: state.repoRef.path,
          active: state.active,
        });
      }
      generation += 1;
      if (reconcileTimer !== null) {
        window.clearTimeout(reconcileTimer);
        reconcileTimer = null;
      }
      if (!state) {
        removeOrphanedUi();
        return;
      }
      state.controller.abort();
      state.render?.destroy();
      void removePreviewSnapshot(state.snapshotId);
      state.nativeListenerCleanup.forEach((cleanup) => cleanup());
      if (state.codeView.isConnected) state.codeView.style.removeProperty('display');
      state.tab.remove();
      state.container.remove();
      state = null;
      removeOrphanedUi();
    };

    const showCode = () => {
      if (!state) return;
      state.active = false;
      // Only deselect the Preview tab; GitHub's React state manages native
      // tab buttons and overrides aria-current/data-selected on re-render.
      state.tabButton.setAttribute('aria-current', 'false');
      state.tabButton.setAttribute('aria-selected', 'false');
      state.tabButton.style.setProperty(
        '--separator-color',
        'var(--borderColor-default)',
      );
      state.tab.removeAttribute('data-selected');
      state.container.style.setProperty('display', 'none', 'important');
      state.codeView.style.removeProperty('display');
      debugLog('blob', 'show-code', { path: state.repoRef.path });
    };

    const showPreview = () => {
      if (!state) return;
      state.active = true;
      setSelectedTab(state.tabBar, state.tabButton);
      state.container.style.setProperty('display', 'flex', 'important');
      state.codeView.style.setProperty('display', 'none', 'important');
      debugLog('blob', 'show-preview', {
        path: state.repoRef.path,
        privateRepo: state.isPrivate,
      });
      void ensureResolved(state);
    };

    const mount = (pageData: BlobPageData, tabBar: HTMLElement, blob: HTMLElement) => {
      if (!pageData.repoRef) return;
      const codeView = findCodeView(blob);
      if (!codeView) return;

      const routeGeneration = ++generation;
      const repoRef = Object.freeze({ ...pageData.repoRef });
      const key = routeKey(repoRef);
      const controller = new AbortController();
      const previewId = `gh-html-preview-${routeGeneration}`;
      const { tab, button } = createPreviewTab(tabBar, previewId, showPreview);
      button.id = `${previewId}-tab`;
      tabBar.appendChild(tab);

      const container = document.createElement('section');
      container.id = previewId;
      container.className = PREVIEW_CONTAINER_CLASS;
      container.setAttribute('role', 'tabpanel');
      container.setAttribute('aria-labelledby', button.id);
      container.style.cssText =
        'display:none;flex-direction:column;height:calc(100dvh - 96px);min-height:600px;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;overflow:hidden;background:var(--bgColor-default,#fff);';

      const header = document.createElement('header');
      header.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;background:var(--bgColor-muted,#f6f8fa);border-bottom:1px solid var(--borderColor-default,#d1d9e0);font-size:12px;color:var(--fgColor-muted,#59636e);';
      const status = document.createElement('strong');
      status.setAttribute('role', 'status');
      status.textContent = pageData.diagnostic ? 'Partial' : 'Ready';
      const fullLink = document.createElement('a');
      fullLink.href = '#';
      fullLink.target = '_blank';
      fullLink.rel = 'noreferrer';
      fullLink.textContent = 'Open full preview';
      fullLink.style.cssText =
        'color:var(--fgColor-muted,#59636e);text-decoration:none;pointer-events:none;';
      fullLink.setAttribute('aria-disabled', 'true');
      const execution = document.createElement('span');
      execution.textContent = 'Executable · Scripts and network access on';
      header.append(status, execution, fullLink);

      const details = document.createElement('p');
      details.style.cssText =
        'display:none;margin:0;padding:8px 12px;border-bottom:1px solid var(--borderColor-default,#d1d9e0);font-size:12px;color:var(--fgColor-muted,#59636e);';

      const previewArea = document.createElement('div');
      previewArea.style.cssText = 'flex:1;min-height:0;overflow:hidden;';
      const placeholder = document.createElement('p');
      placeholder.style.cssText = 'margin:0;padding:24px;text-align:center;';
      placeholder.textContent =
        'Select Preview to run this HTML in an isolated frame. Scripts and network access are on.';
      previewArea.appendChild(placeholder);
      container.append(header, details, previewArea);
      blob.appendChild(container);

      const nativeListenerCleanup: Array<() => void> = [];
      state = {
        generation: routeGeneration,
        key,
        repoRef,
        sourceHtml: pageData.html,
        metadataDiagnostic: pageData.diagnostic,
        isPrivate: pageData.isPrivate,
        controller,
        tab,
        tabButton: button,
        tabBar,
        nativeListenerCleanup,
        container,
        previewArea,
        status,
        details,
        fullLink,
        codeView,
        active: false,
        render: null,
        resolving: null,
        snapshotId: null,
      };
      debugLog('blob', 'mounted', {
        owner: repoRef.owner,
        repo: repoRef.repo,
        ref: repoRef.ref.slice(0, 12),
        path: repoRef.path,
        source: pageData.source,
        privateRepo: pageData.isPrivate,
      });

      for (const nativeButton of Array.from(
        tabBar.querySelectorAll<HTMLButtonElement>('button'),
      )) {
        if (nativeButton === button) continue;
        const listener = () => showCode();
        nativeButton.addEventListener('click', listener);
        nativeListenerCleanup.push(() =>
          nativeButton.removeEventListener('click', listener),
        );
      }
    };

    const reconcile = () => {
      if (!enabled) {
        teardown();
        return;
      }
      const routeFallback = parseBlobUrl(location.href);
      if (!routeFallback || !/\.html?$/i.test(routeFallback.path)) {
        teardown();
        return;
      }

      const pageData = extractBlobPageData();
      const repoRef = pageData.repoRef ?? routeFallback;
      const key = routeKey(repoRef);
      const tabBar = findTabBar();
      const blob = findBlobContainer();
      if (!tabBar || !blob) return;
      debugLog('blob', 'reconcile', {
        path: repoRef.path,
        source: pageData.source,
        privateRepo: pageData.isPrivate,
      });

      const remainPreviewActive = state?.active ?? false;
      if (
        state &&
        (state.key !== key ||
          !state.container.isConnected ||
         !state.tab.isConnected ||
         !state.tabBar.isConnected ||
          (pageData.html !== null && pageData.html !== state.sourceHtml))
      ) {
        teardown();
      }

      if (!state) {
        mount({ ...pageData, repoRef }, tabBar, blob);
        if (remainPreviewActive) showPreview();
        return;
      }

      const currentCodeView = findCodeView(blob);
      if (currentCodeView) {
        const wasActive = state.active;
        state.codeView = currentCodeView;
        if (wasActive) {
          state.codeView.style.setProperty('display', 'none', 'important');
        }
      }
    };

    const scheduleReconcile = () => {
      if (reconcileTimer !== null) window.clearTimeout(reconcileTimer);
      reconcileTimer = window.setTimeout(() => {
        reconcileTimer = null;
        reconcile();
      }, 80);
    };

    const observer = new MutationObserver((mutations) => {
      if (location.href !== lastLocation) {
        debugLog('blob', 'mutation-location-change', {
          from: new URL(lastLocation).pathname,
          to: location.pathname,
        });
        lastLocation = location.href;
        scheduleReconcile();
        return;
      }
      const disconnected =
       state !== null &&
       (!state.container.isConnected ||
         !state.tab.isConnected ||
         !state.tabBar.isConnected);
      const relevant = mutations.some((mutation) =>
        Array.from(mutation.addedNodes).some(
          (node) =>
            node instanceof Element &&
            (node.matches(RELEVANT_DOM_SELECTOR) ||
              node.querySelector(RELEVANT_DOM_SELECTOR) !== null),
        ),
      );
      if (disconnected || relevant) scheduleReconcile();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      debugLog('blob', 'wxt-location-change', { path: location.pathname });
      lastLocation = location.href;
      scheduleReconcile();
    });

    const unwatchEnabled = enabledStorage.watch((next) => {
      enabled = next;
      if (!enabled) teardown();
      else scheduleReconcile();
    });
    void Promise.all([
      enabledStorage.getValue(),
      purgeLegacyCredentials(),
    ]).then(([value]) => {
        enabled = value;
        reconcile();
      });

    ctx.onInvalidated(() => {
      observer.disconnect();
      unwatchEnabled();
      teardown();
    });
  },
});

async function ensureResolved(route: RouteState): Promise<void> {
  if (route.render || route.resolving) return route.resolving ?? Promise.resolve();
  route.status.style.removeProperty('display');
  route.status.textContent = 'Loading';
  route.status.setAttribute('role', 'status');
  route.details.style.display = 'none';
  route.details.textContent = '';
  route.previewArea.replaceChildren(message('Preparing executable preview…'));

  route.resolving = (async () => {
    try {
      debugLog('blob', 'resolve-start', {
        path: route.repoRef.path,
        privateRepo: route.isPrivate,
      });
      const sourceHtml =
        route.sourceHtml ??
        (
          await fetchRepositoryFile(route.repoRef, route.controller.signal, {
            privateRepo: route.isPrivate,
          })
        ).text;
      const result = await resolveHtml(sourceHtml, {
        target: 'sandbox-private',
        repoRef: route.repoRef,
        privateRepo: route.isPrivate,
        signal: route.controller.signal,
      });
      route.controller.signal.throwIfAborted();
      recordResolveMetrics(
        result.performance.resolveMs,
        result.performance.outputBytes,
      );
      route.render = renderExecutablePreview(route.previewArea, result);
      try {
        route.snapshotId = await savePreviewSnapshot(
          result,
          route.repoRef,
          route.isPrivate,
        );
        route.fullLink.href = browser.runtime.getURL(
          `/preview.html?snapshot=${encodeURIComponent(route.snapshotId)}`,
        );
        route.fullLink.style.cssText =
          'color:var(--fgColor-accent,#0969da);text-decoration:none;';
        route.fullLink.removeAttribute('aria-disabled');
      } catch (error) {
        debugError('blob', 'snapshot-save-failed', error, {
          path: route.repoRef.path,
        });
      }
      updateResolvedStatus(route, result);
      debugLog('blob', 'resolve-complete', {
        path: route.repoRef.path,
        fetched: result.resources.fetched,
        inlined: result.resources.inlined,
        failed: result.resources.failed,
        skipped: result.resources.skipped,
        bytes: result.resources.bytes,
      });
    } catch (error) {
      if (route.controller.signal.aborted) return;
      debugError('blob', 'resolve-failed', error, {
        path: route.repoRef.path,
        privateRepo: route.isPrivate,
      });
      route.status.textContent = 'Error';
      route.status.setAttribute('role', 'alert');
      route.details.style.display = 'block';
      const errorMessage =
        error instanceof Error ? error.message : 'Executable preview failed.';
      const text = document.createElement('span');
      text.textContent = errorMessage;
      const retry = createActionButton('Retry', () => {
        window.setTimeout(() => retryResolution(route), 0);
      });
      route.details.replaceChildren(text, retry);
      route.previewArea.replaceChildren(
        message('Preview could not be rendered. Source view remains available.'),
      );
    } finally {
      route.resolving = null;
    }
  })();
  return route.resolving;
}

function updateResolvedStatus(route: RouteState, result: ResolveResult): void {
  const partial =
    route.metadataDiagnostic !== null ||
    result.resources.failed > 0 ||
    result.resources.skipped > 0;
  route.status.setAttribute('role', 'status');
  route.status.textContent = partial
    ? `${result.diagnostics.length + (route.metadataDiagnostic ? 1 : 0)} resource issues`
    : '';
  route.status.style.display = partial ? '' : 'none';
  if (!partial) {
    route.details.replaceChildren();
    route.details.style.display = 'none';
    return;
  }
  const diagnostics = [
    ...(route.metadataDiagnostic
      ? [
          {
            code: 'github-metadata',
            message: route.metadataDiagnostic,
            url: undefined,
          },
        ]
      : []),
    ...result.diagnostics,
  ];
  const disclosure = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'View resource issues';
  const list = document.createElement('ul');
  for (const diagnostic of diagnostics) {
    const item = document.createElement('li');
    item.textContent = diagnostic.url
      ? `${diagnostic.url}: ${diagnostic.message}`
      : diagnostic.message;
    list.append(item);
  }
  const copy = createActionButton('Copy diagnostics', () => {
    void navigator.clipboard.writeText(
      diagnostics
        .map((diagnostic) =>
          diagnostic.url
            ? `${diagnostic.code} ${diagnostic.url}: ${diagnostic.message}`
            : `${diagnostic.code}: ${diagnostic.message}`,
        )
        .join('\n'),
    );
  });
  const retry = createActionButton('Retry', () => {
    window.setTimeout(() => retryResolution(route), 0);
  });
  disclosure.append(summary, list, retry, copy);
  route.details.replaceChildren(disclosure);
  route.details.style.display = 'block';
}

function retryResolution(route: RouteState): void {
  route.render?.destroy();
  route.render = null;
  void removePreviewSnapshot(route.snapshotId);
  route.snapshotId = null;
  route.fullLink.href = '#';
  route.fullLink.style.cssText =
    'color:var(--fgColor-muted,#59636e);text-decoration:none;pointer-events:none;';
  route.fullLink.setAttribute('aria-disabled', 'true');
  route.status.style.removeProperty('display');
  route.status.setAttribute('role', 'status');
  route.status.textContent = 'Retrying…';
  route.details.replaceChildren();
  route.details.style.display = 'none';
  route.previewArea.replaceChildren(message('Retrying preview resources…'));
  void ensureResolved(route);
}

function createActionButton(
  label: string,
  action: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm';
  button.textContent = label;
  button.style.marginInlineStart = '8px';
  button.addEventListener('click', action);
  return button;
}

function findTabBar(): HTMLElement | null {
  return document.querySelector(
    'ul[class*="SegmentedControl"][aria-label="File view"]',
  );
}

function findBlobContainer(): HTMLElement | null {
  const header = document.querySelector('.react-blob-view-header-sticky');
  return (header?.parentElement as HTMLElement) ?? null;
}

function findCodeView(blobContainer: HTMLElement): HTMLElement | null {
  const stickyHeader = blobContainer.querySelector(
    '.react-blob-view-header-sticky',
  );
  for (const child of Array.from(blobContainer.children)) {
    if (child === stickyHeader || child.classList.contains(PREVIEW_CONTAINER_CLASS)) {
      continue;
    }
    if (child.querySelector('.react-code-lines, [data-testid="code-cell"]')) {
      return child as HTMLElement;
    }
  }
  return null;
}

function createPreviewTab(
  tabBar: HTMLElement,
  previewId: string,
  onClick: () => void,
): { tab: HTMLLIElement; button: HTMLButtonElement } {
  const template = tabBar.querySelector<HTMLLIElement>('li:last-child');
  const tab = template
    ? (template.cloneNode(true) as HTMLLIElement)
    : document.createElement('li');
  tab.className = PREVIEW_TAB_CLASS;
  if (template) tab.className = `${template.className} ${PREVIEW_TAB_CLASS}`;
  tab.setAttribute('role', 'presentation');
  tab.removeAttribute('data-selected');
  const button =
    tab.querySelector<HTMLButtonElement>('button') ??
    document.createElement('button');
  if (!button.parentElement) tab.appendChild(button);
  button.type = 'button';
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', previewId);
  button.setAttribute('aria-selected', 'false');
  button.setAttribute('aria-current', 'false');
  button.style.setProperty(
    '--separator-color',
    'var(--borderColor-default)',
  );
  const text =
    button.querySelector<HTMLElement>('[data-text]') ??
    button.querySelector<HTMLElement>('.segmentedControl-text');
  if (text) {
    text.textContent = 'Preview';
    text.setAttribute('data-text', 'Preview');
  } else {
    button.textContent = 'Preview';
  }
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  tab.appendChild(button);
  return { tab, button };
}

function setSelectedTab(
  tabBar: HTMLElement,
  selectedButton: HTMLButtonElement | null,
): void {
  for (const button of Array.from(
    tabBar.querySelectorAll<HTMLButtonElement>('button'),
  )) {
    const selected = button === selectedButton;
    button.setAttribute('aria-current', String(selected));
    if (button.closest('li')?.classList.contains(PREVIEW_TAB_CLASS)) {
      button.setAttribute('aria-selected', String(selected));
    }
    button.style.setProperty(
      '--separator-color',
      selected ? 'transparent' : 'var(--borderColor-default)',
    );
    const item = button.closest('li');
    if (selected) item?.setAttribute('data-selected', '');
    else item?.removeAttribute('data-selected');
  }
}

function routeKey(repoRef: Readonly<RepoRef>): string {
  return `${repoRef.owner}/${repoRef.repo}@${repoRef.ref}:${repoRef.path}`;
}

function message(text: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.style.cssText = 'margin:0;padding:24px;text-align:center;';
  element.textContent = text;
  return element;
}

function removeOrphanedUi(): void {
  document
    .querySelectorAll(`.${PREVIEW_TAB_CLASS}, .${PREVIEW_CONTAINER_CLASS}`)
    .forEach((element) => element.remove());
}
