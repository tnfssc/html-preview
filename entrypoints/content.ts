import {
  extractBlobPageData,
  fetchPublicFile,
  parseBlobUrl,
} from '@/utils/github';
import { resolveHtml } from '@/utils/resolveHtml';
import { renderStaticPreview, type RenderResult } from '@/utils/renderer';
import { enabledStorage } from '@/utils/storage';
import type { BlobPageData } from '@/utils/github';
import type { RepoRef, ResolveResult } from '@/utils/types';

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
  readonly controller: AbortController;
  readonly tab: HTMLElement;
  readonly tabButton: HTMLButtonElement;
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

    const teardown = () => {
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
      if (state.codeView.isConnected) state.codeView.style.removeProperty('display');
      state.tab.remove();
      state.container.remove();
      state = null;
      removeOrphanedUi();
    };

    const showCode = () => {
      if (!state) return;
      state.active = false;
      state.tabButton.setAttribute('aria-selected', 'false');
      state.tabButton.removeAttribute('aria-current');
      state.container.style.setProperty('display', 'none', 'important');
      state.codeView.style.removeProperty('display');
    };

    const showPreview = () => {
      if (!state) return;
      state.active = true;
      state.tabButton.setAttribute('aria-selected', 'true');
      state.tabButton.setAttribute('aria-current', 'page');
      state.container.style.setProperty('display', 'flex', 'important');
      state.codeView.style.setProperty('display', 'none', 'important');
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
      const { tab, button } = createPreviewTab(previewId, showPreview);
      tabBar.appendChild(tab);

      const container = document.createElement('section');
      container.id = previewId;
      container.className = PREVIEW_CONTAINER_CLASS;
      container.setAttribute('aria-label', 'Static HTML preview');
      container.style.cssText =
        'display:none;flex-direction:column;min-height:80vh;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;overflow:hidden;background:var(--bgColor-default,#fff);';

      const header = document.createElement('header');
      header.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;background:var(--bgColor-muted,#f6f8fa);border-bottom:1px solid var(--borderColor-default,#d1d9e0);font-size:12px;color:var(--fgColor-muted,#59636e);';
      const status = document.createElement('strong');
      status.setAttribute('role', 'status');
      status.textContent = pageData.diagnostic ? 'Partial' : 'Ready';
      const fullLink = document.createElement('a');
      fullLink.href = buildPreviewPageUrl(repoRef);
      fullLink.target = '_blank';
      fullLink.rel = 'noreferrer';
      fullLink.textContent = 'Open full preview';
      fullLink.style.cssText =
        'color:var(--fgColor-accent,#0969da);text-decoration:none;';
      header.append(status, fullLink);

      const details = document.createElement('p');
      details.style.cssText =
        'margin:0;padding:8px 12px;border-bottom:1px solid var(--borderColor-default,#d1d9e0);font-size:12px;color:var(--fgColor-muted,#59636e);';
      details.textContent =
        pageData.diagnostic ??
        'Static preview blocks scripts and external network. Repository assets load on demand.';

      const previewArea = document.createElement('div');
      previewArea.style.cssText = 'flex:1;min-height:400px;';
      const placeholder = document.createElement('p');
      placeholder.style.cssText = 'margin:0;padding:24px;text-align:center;';
      placeholder.textContent = 'Select Preview to render this file safely.';
      previewArea.appendChild(placeholder);
      container.append(header, details, previewArea);
      blob.appendChild(container);

      state = {
        generation: routeGeneration,
        key,
        repoRef,
        sourceHtml: pageData.html,
        metadataDiagnostic: pageData.diagnostic,
        controller,
        tab,
        tabButton: button,
        container,
        previewArea,
        status,
        details,
        codeView,
        active: false,
        render: null,
        resolving: null,
      };

      for (const nativeButton of Array.from(
        tabBar.querySelectorAll<HTMLButtonElement>('button'),
      )) {
        if (nativeButton === button) continue;
        ctx.addEventListener(nativeButton, 'click', showCode);
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

      if (
        state &&
        (state.key !== key ||
          !state.container.isConnected ||
          (!state.sourceHtml && pageData.html))
      ) {
        teardown();
      }

      if (!state) {
        mount({ ...pageData, repoRef }, tabBar, blob);
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
      teardown();
      scheduleReconcile();
    });

    const unwatchEnabled = enabledStorage.watch((next) => {
      enabled = next;
      if (!enabled) teardown();
      else scheduleReconcile();
    });

    void enabledStorage.getValue().then((value) => {
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
  route.status.textContent = 'Loading';
  route.details.textContent = 'Fetching and inlining repository resources…';
  route.previewArea.replaceChildren(message('Loading static preview…'));

  route.resolving = (async () => {
    try {
      const sourceHtml =
        route.sourceHtml ??
        (await fetchPublicFile(route.repoRef, route.controller.signal));
      const result = await resolveHtml(sourceHtml, {
        target: 'static',
        repoRef: route.repoRef,
        signal: route.controller.signal,
      });
      route.controller.signal.throwIfAborted();
      route.render = renderStaticPreview(route.previewArea, result);
      updateResolvedStatus(route, result);
    } catch (error) {
      if (route.controller.signal.aborted) return;
      route.status.textContent = 'Error';
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
  const summary = `${result.resources.inlined} resources inlined, ${formatBytes(result.resources.bytes)} fetched`;
  if (partial) {
    const first = result.diagnostics[0]?.message ?? route.metadataDiagnostic;
    route.details.textContent = first ? `${summary}. ${first}` : `${summary}. Some resources were omitted.`;
  } else {
    route.details.textContent = `${summary}. Scripts and external network remain blocked.`;
  }
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
  previewId: string,
  onClick: () => void,
): { tab: HTMLLIElement; button: HTMLButtonElement } {
  const tab = document.createElement('li');
  tab.className = PREVIEW_TAB_CLASS;
  tab.setAttribute('role', 'presentation');
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', previewId);
  button.setAttribute('aria-selected', 'false');
  button.textContent = 'Preview';
  button.style.cssText =
    'min-height:32px;padding:5px 12px;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:0 6px 6px 0;background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);font:inherit;cursor:pointer;';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  tab.appendChild(button);
  return { tab, button };
}

function buildPreviewPageUrl(repoRef: Readonly<RepoRef>): string {
  const params = new URLSearchParams({
    owner: repoRef.owner,
    repo: repoRef.repo,
    ref: repoRef.ref,
    path: repoRef.path,
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function removeOrphanedUi(): void {
  document
    .querySelectorAll(`.${PREVIEW_TAB_CLASS}, .${PREVIEW_CONTAINER_CLASS}`)
    .forEach((element) => element.remove());
}
