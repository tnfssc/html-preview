import {
  extractBlobPageData,
  fetchRepositoryFile,
  parseBlobUrl,
} from '@/utils/github';
import { resolveHtml } from '@/utils/resolveHtml';
import { renderStaticPreview, type RenderResult } from '@/utils/renderer';
import { enabledStorage, githubTokenStorage } from '@/utils/storage';
import type { BlobPageData } from '@/utils/github';
import type { RepoRef, ResolveResult } from '@/utils/types';
import { debugError, debugLog } from '@/utils/debug';

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
  codeView: HTMLElement;
  active: boolean;
  render: RenderResult | null;
  resolving: Promise<void> | null;
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
      state.nativeListenerCleanup.forEach((cleanup) => cleanup());
      if (state.codeView.isConnected) state.codeView.style.removeProperty('display');
      state.tab.remove();
      state.container.remove();
      state = null;
      removeOrphanedUi();
    };

    const showCode = (selectedButton?: HTMLButtonElement) => {
      if (!state) return;
      state.active = false;
      setSelectedTab(state.tabBar, selectedButton ?? null);
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
      tabBar.appendChild(tab);

      const container = document.createElement('section');
      container.id = previewId;
      container.className = PREVIEW_CONTAINER_CLASS;
      container.setAttribute('aria-label', 'Static HTML preview');
      container.style.cssText =
        'display:none;flex-direction:column;height:calc(100dvh - 96px);min-height:600px;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;overflow:hidden;background:var(--bgColor-default,#fff);';

      const header = document.createElement('header');
      header.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;background:var(--bgColor-muted,#f6f8fa);border-bottom:1px solid var(--borderColor-default,#d1d9e0);font-size:12px;color:var(--fgColor-muted,#59636e);';
      const status = document.createElement('strong');
      status.setAttribute('role', 'status');
      status.textContent = pageData.diagnostic ? 'Partial' : 'Ready';
      const fullLink = document.createElement('a');
      fullLink.href = buildPreviewPageUrl(repoRef, pageData.isPrivate);
      fullLink.target = '_blank';
      fullLink.rel = 'noreferrer';
      fullLink.textContent = 'Open full preview';
      fullLink.style.cssText =
        'color:var(--fgColor-accent,#0969da);text-decoration:none;';
      header.append(status, fullLink);

      const details = document.createElement('p');
      details.style.cssText =
        'display:none;margin:0;padding:8px 12px;border-bottom:1px solid var(--borderColor-default,#d1d9e0);font-size:12px;color:var(--fgColor-muted,#59636e);';

      const previewArea = document.createElement('div');
      previewArea.style.cssText = 'flex:1;min-height:0;overflow:hidden;';
      const placeholder = document.createElement('p');
      placeholder.style.cssText = 'margin:0;padding:24px;text-align:center;';
      placeholder.textContent = 'Select Preview to render this file safely.';
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
        codeView,
        active: false,
        render: null,
        resolving: null,
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
        const listener = () => showCode(nativeButton);
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
      const disconnected = state !== null && !state.container.isConnected;
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
    const unwatchToken = githubTokenStorage.watch(() => {
      const wasActive = state?.active ?? false;
      teardown();
      reconcile();
      if (wasActive) showPreview();
    });

    void enabledStorage.getValue().then((value) => {
      enabled = value;
      reconcile();
    });

    ctx.onInvalidated(() => {
      observer.disconnect();
      unwatchEnabled();
      unwatchToken();
      teardown();
    });
  },
});

async function ensureResolved(route: RouteState): Promise<void> {
  if (route.render || route.resolving) return route.resolving ?? Promise.resolve();
  route.status.textContent = 'Loading';
  route.details.style.display = 'none';
  route.details.textContent = '';
  route.previewArea.replaceChildren(message('Loading static preview…'));

  route.resolving = (async () => {
    try {
      const githubToken = await githubTokenStorage.getValue();
      debugLog('blob', 'resolve-start', {
        path: route.repoRef.path,
        privateRepo: route.isPrivate,
        tokenConfigured: Boolean(githubToken),
      });
      if (route.isPrivate && !githubToken) {
        throw new Error(
          'Private repository access requires a fine-grained GitHub token saved in the extension popup.',
        );
      }
      const sourceHtml =
        route.sourceHtml ??
        (
          await fetchRepositoryFile(route.repoRef, route.controller.signal, {
            token: githubToken,
            privateRepo: route.isPrivate,
          })
        ).text;
      const result = await resolveHtml(sourceHtml, {
        target: route.isPrivate ? 'sandbox-private' : 'sandbox',
        repoRef: route.repoRef,
        githubToken,
        privateRepo: route.isPrivate,
        signal: route.controller.signal,
      });
      route.controller.signal.throwIfAborted();
      route.render = renderStaticPreview(route.previewArea, result);
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
      route.details.style.display = 'block';
      route.details.textContent =
        error instanceof Error ? error.message : 'Static preview failed.';
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
  route.status.textContent = partial ? 'Partial' : 'Ready';
  route.details.style.display = 'none';
  route.details.textContent = '';
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

function buildPreviewPageUrl(
  repoRef: Readonly<RepoRef>,
  isPrivate: boolean,
): string {
  const params = new URLSearchParams({
    owner: repoRef.owner,
    repo: repoRef.repo,
    ref: repoRef.ref,
    path: repoRef.path,
    ...(isPrivate ? { private: '1' } : {}),
  });
  return browser.runtime.getURL(`/preview.html?${params.toString()}`);
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
