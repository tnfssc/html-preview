import {
  fetchRepositoryFile,
  parseBlobUrl,
  parseHtmlDiffUrl,
  type HtmlDiffRoute,
} from '@/utils/github';
import {
  comparisonPreferencesStorage,
  enabledStorage,
  purgeLegacyCredentials,
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
import { fetchWithRetry } from '@/utils/fetchWithRetry';

const PREVIEW_CONTROLS_CLASS = 'gh-html-preview-pr-controls';
const RICH_CONTAINER_CLASS = 'gh-html-preview-pr-rich';
const FALLBACK_LIST_CLASS = 'gh-html-preview-fallback-diffs';
const DIFF_SELECTOR =
  '#files .file, [data-testid="diff-file"], [data-testid="diff-file-header"], [data-diff-header-wrapper], [role="region"][id^="diff-"], table[aria-label^="Diff for:"]';

interface DiffSide {
  owner: string;
  repo: string;
  sha: string;
  privateRepo: boolean;
}

interface DiffComparison {
  base: DiffSide;
  head: DiffSide;
}

interface DiffFileInfo {
  filename: string;
  previousFilename: string | null;
  status: string;
}

interface DiffRouteState {
  readonly key: string;
  readonly route: HtmlDiffRoute;
  readonly controller: AbortController;
  metadata: Promise<DiffComparison> | null;
  fileMetadata: Promise<DiffFileInfo[]> | null;
  sessionPullData: Promise<Record<string, unknown> | null> | null;
  fallbackPromise: Promise<number> | null;
  readonly richDiffs: Set<RichDiffState>;
}

class ExpectedMissingSideError extends Error {}

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
  readonly initialHead: DiffSide | null;
  readonly sourceButton: HTMLButtonElement;
  readonly splitButton: HTMLButtonElement;
  readonly container: HTMLElement;
  readonly status: HTMLElement;
  readonly comparisonArea: HTMLElement;
  readonly basePane: HTMLElement;
  readonly headPane: HTMLElement;
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
  collapseCleanup: () => void;
  readonly hiddenCodeElements: Set<HTMLElement>;
  controller: AbortController | null;
  baseRender: RenderResult | null;
  headRender: RenderResult | null;
  retryableFailures: number;
  comparison: DiffComparison | null;
  resolving: Promise<void> | null;
  mode: 'source' | 'split';
}

export default defineContentScript({
  matches: ['*://github.com/*'],
  runAt: 'document_end',
  main(ctx) {
    debugLog('pr', 'content-script-start', {
      path: location.pathname,
    });
    let enabled = true;
    let preferences: ComparisonPreferences = {
      mode: 'source',
      viewport: 'responsive',
      syncScroll: true,
    };
    let state: DiffRouteState | null = null;
    let renderTimer: number | null = null;
    let lastLocation = location.href;

    const clearControls = () => {
      for (const rich of state?.richDiffs ?? []) {
        rich.controller?.abort();
        rich.baseRender?.destroy();
        rich.headRender?.destroy();
        rich.resizeObserver.disconnect();
        rich.fullscreenCleanup();
        rich.collapseCleanup();
        showCodeDiff(rich);
        rich.container.remove();
      }
      document
        .querySelectorAll(
          `.${PREVIEW_CONTROLS_CLASS}, .${RICH_CONTAINER_CLASS}, .${FALLBACK_LIST_CLASS}`,
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

    const renderCards = (routeState: DiffRouteState) => {
      let targets = findDiffTargets();
      const nativePaths = new Set(
        targets
          .filter((target) => !target.file.dataset.ghHtmlPreviewPath)
          .map((target) => target.path),
      );
      for (const target of targets) {
        if (
          target.file.dataset.ghHtmlPreviewPath &&
          nativePaths.has(target.path)
        ) {
          target.file.remove();
        }
      }
      targets = targets.filter((target) => target.file.isConnected);
      for (const rich of Array.from(routeState.richDiffs)) {
        if (rich.target.file.isConnected) continue;
        rich.controller?.abort();
        rich.baseRender?.destroy();
        rich.headRender?.destroy();
        rich.resizeObserver.disconnect();
        rich.fullscreenCleanup();
        rich.collapseCleanup();
        routeState.richDiffs.delete(rich);
      }
      document
        .querySelector(`.${FALLBACK_LIST_CLASS}:empty`)
        ?.remove();
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
      for (const target of targets) {
        if (target.header.querySelector(`.${PREVIEW_CONTROLS_CLASS}`)) {
          const existing = Array.from(routeState.richDiffs).find(
            (rich) => rich.target.header === target.header,
          );
          if (existing) {
            existing.target.fileContent = target.fileContent;
            if (existing.mode === 'split') {
              hideCodeDiff(existing);
            }
          }
          continue;
        }
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
          routeState,
          preferences,
        );
      }
      if (
        routeState.route.kind !== 'pull' &&
        !routeState.fallbackPromise
      ) {
        routeState.fallbackPromise = ensureFallbackDiffCards(
          routeState,
          targets.map((target) => target.path),
        )
          .catch((error: unknown) => {
            debugError('pr', 'fallback-diffs-failed', error);
            return 0;
          })
          .then((created) => {
            if (created > 0 && !routeState.controller.signal.aborted) {
              scheduleRender();
            }
            return created;
          })
          .finally(() => {
            routeState.fallbackPromise = null;
          });
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
      const route = enabled ? parseHtmlDiffUrl(location.href) : null;
      debugLog('pr', 'route-reconcile', {
        path: location.pathname,
        enabled,
        matched: Boolean(route),
      });
      if (!route) {
        stopRoute();
        return;
      }
      const key = `${route.owner}/${route.repo}:${route.kind}:${
        route.kind === 'pull'
          ? route.pullNumber
          : route.kind === 'commit'
            ? route.head
            : `${route.base}...${route.head}`
      }`;
      if (state?.key !== key) {
        stopRoute();
        const controller = new AbortController();
        state = {
          key,
          route: Object.freeze({ ...route }),
          controller,
          metadata: null,
          fileMetadata: null,
          sessionPullData: null,
          fallbackPromise: null,
          richDiffs: new Set(),
        };
      }
      scheduleRender();
    };

    const observer = new MutationObserver((mutations) => {
      if (location.href !== lastLocation) {
        lastLocation = location.href;
        reconcileRoute();
        return;
      }
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

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      lastLocation = location.href;
      reconcileRoute();
    });
    const unwatchEnabled = enabledStorage.watch((next) => {
      enabled = next;
      reconcileRoute();
    });
    void Promise.all([
      enabledStorage.getValue(),
      comparisonPreferencesStorage.getValue(),
      purgeLegacyCredentials(),
    ]).then(([storedEnabled, storedPreferences]) => {
      enabled = storedEnabled;
      preferences = storedPreferences;
      reconcileRoute();
    });

    ctx.onInvalidated(() => {
      observer.disconnect();
      unwatchEnabled();
      stopRoute();
    });
  },
});

async function fetchDiffComparison(
  routeState: DiffRouteState,
): Promise<DiffComparison> {
  const { route } = routeState;
  const { signal } = routeState.controller;
  if (route.kind !== 'pull') {
    return fetchRevisionComparison(route, signal);
  }
  const embedded = parseEmbeddedPullComparison(route);
  if (embedded) return embedded;
  const url = `https://api.github.com/repos/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}/pulls/${route.pullNumber}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  debugLog('pr', 'metadata-fetch', {
    owner: route.owner,
    repo: route.repo,
    pull: route.pullNumber,
  });
  const response = await fetchWithRetry(url, {
    signal,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers,
  });
  if (!response.ok) {
    const embedded = parseEmbeddedPullComparison(
      route,
      await getSessionPullChangesRoute(routeState),
    );
    if (embedded) return embedded;
    throw new Error(
      response.status === 404
        ? 'GitHub API returned HTTP 404. Sign into GitHub and organization SSO in this tab, then try again.'
        : `GitHub API returned HTTP ${response.status}`,
    );
  }

  const data = (await response.json()) as unknown;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('GitHub API returned invalid PR metadata.');
  }
  return {
    base: parsePullSide((data as Record<string, unknown>).base, 'base'),
    head: parsePullSide((data as Record<string, unknown>).head, 'head'),
  };
}

async function fetchRevisionComparison(
  route: Exclude<HtmlDiffRoute, { kind: 'pull' }>,
  signal: AbortSignal,
): Promise<DiffComparison> {
  const endpoint =
    route.kind === 'commit'
      ? `commits/${encodeURIComponent(route.head)}`
      : `compare/${encodeURIComponent(route.base)}...${encodeURIComponent(route.head)}`;
  let repository: Record<string, unknown>;
  let data: Record<string, unknown>;
  try {
    [repository, data] = await Promise.all([
      fetchGitHubApiRecord(
        `https://api.github.com/repos/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}`,
        signal,
        'repository metadata',
      ),
      fetchGitHubApiRecord(
        `https://api.github.com/repos/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}/${endpoint}`,
        signal,
        `${route.kind} metadata`,
      ),
    ]);
  } catch (error) {
    const embedded = await fetchSessionRevisionComparison(route, signal);
    if (embedded) return embedded;
    throw error;
  }
  const privateRepo = repository.private === true;

  let baseSha: string;
  let headSha: string;
  if (route.kind === 'commit') {
    headSha = parseCommitSha(data, 'commit');
    const parents = data.parents;
    if (!Array.isArray(parents) || parents.length === 0) {
      throw new Error('Root commits have no Before revision.');
    }
    baseSha = parseCommitSha(parents[0], 'parent commit');
  } else {
    baseSha = parseCommitSha(data.base_commit, 'compare base');
    const commits = data.commits;
    if (!Array.isArray(commits) || commits.length === 0) {
      throw new Error('Comparison contains no head commit.');
    }
    headSha = parseCommitSha(commits.at(-1), 'compare head');
  }

  const side = (sha: string): DiffSide => ({
    owner: route.owner,
    repo: route.repo,
    sha,
    privateRepo,
  });
  return { base: side(baseSha), head: side(headSha) };
}

async function fetchSessionRevisionComparison(
  route: Exclude<HtmlDiffRoute, { kind: 'pull' }>,
  signal: AbortSignal,
): Promise<DiffComparison | null> {
  if (location.origin !== 'https://github.com') return null;
  const refs =
    route.kind === 'commit'
      ? [route.head]
      : [route.base, route.head];
  const revisions = await Promise.all(
    refs.map((ref) =>
      fetchSessionCommitMetadata(route.owner, route.repo, ref, signal),
    ),
  );
  if (revisions.some((revision) => revision === null)) return null;
  const side = (sha: string): DiffSide => ({
    owner: route.owner,
    repo: route.repo,
    sha,
    privateRepo: true,
  });
  if (route.kind === 'commit') {
    const commit = revisions[0];
    const parent = commit?.parents[0];
    if (!commit || !parent) return null;
    return { base: side(parent), head: side(commit.oid) };
  }
  const base = revisions[0];
  const head = revisions[1];
  if (!base || !head) return null;
  return { base: side(base.oid), head: side(head.oid) };
}

async function fetchSessionCommitMetadata(
  owner: string,
  repo: string,
  ref: string,
  signal: AbortSignal,
): Promise<{ oid: string; parents: string[] } | null> {
  try {
    const response = await fetchWithRetry(
      `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commit/${encodeURIComponent(ref)}`,
      {
        signal,
        credentials: 'same-origin',
        redirect: 'follow',
        referrerPolicy: 'same-origin',
      },
    );
    if (
      !response.ok ||
      new URL(response.url).origin !== 'https://github.com'
    ) {
      await response.body?.cancel();
      return null;
    }
    const documentNode = new DOMParser().parseFromString(
      await response.text(),
      'text/html',
    );
    const script = documentNode.querySelector(
      'script[data-target="react-app.embeddedData"]',
    );
    if (!script?.textContent) return null;
    const root = asRecord(JSON.parse(script.textContent));
    const payload = asRecord(root?.payload);
    const commit = asRecord(payload?.commit);
    const oid = commit?.oid;
    const parents = commit?.parents;
    if (
      typeof oid !== 'string' ||
      !/^[0-9a-f]{40}$/i.test(oid) ||
      !Array.isArray(parents)
    ) {
      return null;
    }
    const validParents = parents.filter(
      (parent): parent is string =>
        typeof parent === 'string' && /^[0-9a-f]{40}$/i.test(parent),
    );
    return { oid, parents: validParents };
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

async function fetchGitHubApiRecord(
  url: string,
  signal: AbortSignal,
  label: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const response = await fetchWithRetry(url, {
    signal,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers,
  });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? `GitHub ${label} API returned HTTP 404. Sign into GitHub and organization SSO in this tab, then try again.`
        : `GitHub ${label} API returned HTTP ${response.status}.`,
    );
  }
  const data = (await response.json()) as unknown;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`GitHub ${label} API returned invalid metadata.`);
  }
  return data as Record<string, unknown>;
}

function parseCommitSha(value: unknown, label: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`GitHub ${label} metadata is missing.`);
  }
  const sha = (value as Record<string, unknown>).sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`GitHub ${label} SHA is invalid.`);
  }
  return sha;
}

function parsePullSide(value: unknown, label: 'base' | 'head'): DiffSide {
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

function parseEmbeddedPullComparison(
  route: Extract<HtmlDiffRoute, { kind: 'pull' }>,
  data: Record<string, unknown> | null = readEmbeddedPullChangesRoute(),
): DiffComparison | null {
  if (!data) return null;
  const pullRequest = asRecord(data.pullRequest);
  const routeComparison = asRecord(data.comparison);
  const comparison =
    asRecord(pullRequest?.comparison) ??
    asRecord(routeComparison?.fullDiff);
  const baseSha = comparison?.baseOid;
  const headSha = comparison?.headOid;
  const headOwner = pullRequest?.headRepositoryOwnerLogin;
  const headRepo = pullRequest?.headRepositoryName;
  if (
    typeof baseSha !== 'string' ||
    typeof headSha !== 'string' ||
    typeof headOwner !== 'string' ||
    typeof headRepo !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(baseSha) ||
    !/^[0-9a-f]{40}$/i.test(headSha)
  ) {
    return null;
  }
  return {
    base: {
      owner: route.owner,
      repo: route.repo,
      sha: baseSha,
      privateRepo: true,
    },
    head: {
      owner: headOwner,
      repo: headRepo,
      sha: headSha,
      privateRepo: true,
    },
  };
}

function readEmbeddedPullChangesRoute(
  root: ParentNode = document,
): Record<string, unknown> | null {
  for (const script of root.querySelectorAll(
    'script[data-target="react-app.embeddedData"]',
  )) {
    if (!script.textContent?.includes('"pullRequestsChangesRoute"')) continue;
    try {
      const root = asRecord(JSON.parse(script.textContent));
      const payload = asRecord(root?.payload);
      const route = asRecord(payload?.pullRequestsChangesRoute);
      if (route) return route;
    } catch {
      return null;
    }
  }
  return null;
}

async function getSessionPullChangesRoute(
  routeState: DiffRouteState,
): Promise<Record<string, unknown> | null> {
  const embedded = readEmbeddedPullChangesRoute();
  if (embedded || routeState.route.kind !== 'pull') return embedded;
  routeState.sessionPullData ??= fetchSessionPullChangesRoute(
    routeState.route,
    routeState.controller.signal,
  ).catch((error: unknown) => {
    routeState.sessionPullData = null;
    if (routeState.controller.signal.aborted) throw error;
    debugError('pr', 'session-pull-metadata-failed', error);
    return null;
  });
  return routeState.sessionPullData;
}

async function fetchSessionPullChangesRoute(
  route: Extract<HtmlDiffRoute, { kind: 'pull' }>,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  if (location.origin !== 'https://github.com') return null;
  const response = await fetchWithRetry(
    `https://github.com/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}/pull/${route.pullNumber}/changes`,
    {
      signal,
      credentials: 'same-origin',
      redirect: 'follow',
      referrerPolicy: 'same-origin',
    },
  );
  if (
    !response.ok ||
    new URL(response.url).origin !== 'https://github.com'
  ) {
    await response.body?.cancel();
    return null;
  }
  const documentNode = new DOMParser().parseFromString(
    await response.text(),
    'text/html',
  );
  return readEmbeddedPullChangesRoute(documentNode);
}

function parseEmbeddedPullFiles(
  data: Record<string, unknown> | null = readEmbeddedPullChangesRoute(),
): DiffFileInfo[] {
  const contents = data?.diffContents;
  if (!Array.isArray(contents)) return [];
  return contents.flatMap((value): DiffFileInfo[] => {
    const item = asRecord(value);
    const path = item?.path;
    const status = item?.status;
    if (typeof path !== 'string' || typeof status !== 'string') return [];
    const oldEntry = asRecord(item?.oldTreeEntry);
    const previousPath =
      typeof oldEntry?.path === 'string' && oldEntry.path !== path
        ? oldEntry.path
        : null;
    return [
      {
        filename: path,
        previousFilename: previousPath,
        status: status.toLowerCase(),
      },
    ];
  });
}

function parseEmbeddedCommitFiles(): DiffFileInfo[] {
  for (const script of document.querySelectorAll(
    'script[data-target="react-app.embeddedData"]',
  )) {
    if (!script.textContent?.includes('"diffEntryData"')) continue;
    try {
      const root = asRecord(JSON.parse(script.textContent));
      const payload = asRecord(root?.payload);
      const entries = payload?.diffEntryData;
      if (!Array.isArray(entries)) continue;
      return entries.flatMap((value): DiffFileInfo[] => {
        const item = asRecord(value);
        const path = item?.path;
        const status = item?.status;
        if (typeof path !== 'string' || typeof status !== 'string') return [];
        return [
          {
            filename: path,
            previousFilename: null,
            status: status.toLowerCase(),
          },
        ];
      });
    } catch {
      return [];
    }
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

  for (const file of Array.from(
    document.querySelectorAll<HTMLElement>('[role="region"]'),
  )) {
    const table = file.querySelector<HTMLTableElement>(
      'table[aria-label^="Diff for:"]',
    );
    const wrapper = file.firstElementChild;
    const header = wrapper?.firstElementChild;
    const fallbackContent =
      file.lastElementChild instanceof HTMLElement &&
      file.lastElementChild.matches('.border')
        ? file.lastElementChild
        : null;
    const fileContent =
      table?.closest<HTMLElement>('.border') ?? fallbackContent;
    const path =
      file
        .querySelector<HTMLElement>('[data-file-path]')
        ?.getAttribute('data-file-path') ??
      table?.getAttribute('aria-label')?.replace(/^Diff for:\s*/, '') ??
      file
        .querySelector<HTMLElement>('h3 code')
        ?.textContent?.replace(/[\u200e\u200f]/g, '')
        .trim() ??
      null;
    const actions =
      header instanceof HTMLElement && header.lastElementChild instanceof HTMLElement
        ? header.lastElementChild
        : null;
    if (
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
  initialHead: DiffSide | null,
  routeState: DiffRouteState,
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

  const sourceButton = createTextDiffButton('Code', 'Display code diff');
  sourceButton.classList.add('selected');
  sourceButton.setAttribute('aria-selected', 'true');
  const splitButton = createTextDiffButton(
    'Preview',
    'Display before and after previews',
  );
  const modeId = crypto.randomUUID();
  for (const [button, suffix] of [
    [sourceButton, 'source'],
    [splitButton, 'split'],
  ] as const) {
    button.id = `gh-html-preview-${modeId}-${suffix}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', button === sourceButton ? 'true' : 'false');
  }
  controls.append(sourceButton, splitButton);

  const container = document.createElement('section');
  container.id = `gh-html-preview-${modeId}-panel`;
  container.className = RICH_CONTAINER_CLASS;
  container.setAttribute('role', 'tabpanel');
  container.setAttribute('aria-labelledby', splitButton.id);
  for (const button of [sourceButton, splitButton]) {
    button.setAttribute('aria-controls', container.id);
  }
  sourceButton.tabIndex = 0;
  controls.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [sourceButton, splitButton];
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
    'display:none;position:relative;flex-direction:column;height:calc(100dvh - 160px);min-height:500px;border-top:1px solid var(--borderColor-default,#d1d9e0);background:var(--bgColor-default,#fff);';
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText =
    'display:none;';
  status.textContent = 'Choose Preview';
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
  const reloadButton = createToolbarButton('Retry');
  reloadButton.style.cssText =
    'display:none;position:absolute;top:8px;right:8px;z-index:3;box-shadow:var(--shadow-resting-small,0 1px 2px rgba(31,35,40,.15));';
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

  const comparisonArea = document.createElement('div');
  comparisonArea.style.cssText =
    'display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);flex:1;min-height:0;overflow:hidden;background:var(--bgColor-muted,#f6f8fa);';
  const base = createComparisonPane();
  const head = createComparisonPane();
  comparisonArea.append(base.pane, head.pane);
  container.append(toolbar, status, reloadButton, comparisonArea);
  target.fileContent.before(container);
  target.actions.prepend(controls);

  const resizeObserver = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const bothVisible =
      base.pane.style.display !== 'none' && head.pane.style.display !== 'none';
    const stacked = entry.contentRect.width < 900 && bothVisible;
    comparisonArea.style.gridTemplateColumns = stacked
      ? 'minmax(0,1fr)'
      : bothVisible
        ? 'minmax(0,1fr) minmax(0,1fr)'
        : 'minmax(0,1fr)';
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
    container,
    status,
    comparisonArea,
    basePane: base.pane,
    headPane: head.pane,
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
    collapseCleanup: () => {},
    hiddenCodeElements: new Set(),
    controller: null,
    baseRender: null,
    headRender: null,
    retryableFailures: 0,
    comparison: null,
    resolving: null,
    mode: 'source',
  };
  const collapseButton = target.header.querySelector<HTMLButtonElement>(
    'button[aria-expanded], button[aria-label*="collapse" i]',
  );
  if (collapseButton) {
    const handleCollapse = () => {
      const labelledBy = collapseButton.getAttribute('aria-labelledby');
      const label = labelledBy
        ? document.getElementById(labelledBy)?.textContent ?? ''
        : collapseButton.getAttribute('aria-label') ?? '';
      const collapsing = /collapse file/i.test(label);
      richState.container.style.display = collapsing
        ? 'none'
        : richState.mode === 'split'
          ? 'flex'
          : 'none';
    };
    collapseButton.addEventListener('click', handleCollapse, { capture: true });
    richState.collapseCleanup = () =>
      collapseButton.removeEventListener('click', handleCollapse, {
        capture: true,
      });
  }
  routeState.richDiffs.add(richState);

  if (!initialHead) {
    void getDiffComparison(routeState)
      .then((comparison) => {
        if (!richState.container.isConnected) return;
        richState.comparison = comparison;
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
    showRenderedDiff(richState);
    startRender(richState, routeState, false);
  });
  reloadButton.addEventListener('click', () => {
    if (richState.mode !== 'source') {
      showRenderedDiff(richState);
      startRender(richState, routeState, true);
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
  if (preferences.mode === 'split' || preferences.mode === 'after') {
    queueMicrotask(() => splitButton.click());
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
  showCodeDiff(state);
}

function showRenderedDiff(
  state: RichDiffState,
): void {
  state.mode = 'split';
  selectModeButton(state, state.splitButton);
  state.basePane.style.display = 'flex';
  state.headPane.style.display = 'flex';
  state.syncLabel.style.display = 'inline-flex';
  state.overlayLabel.style.display = 'inline-flex';
  state.comparisonArea.style.gridTemplateColumns =
    state.container.clientWidth >= 900
      ? 'minmax(0,1fr) minmax(0,1fr)'
      : 'minmax(0,1fr)';
  hideCodeDiff(state);
  state.container.style.display = 'flex';
}

function showCodeDiff(state: RichDiffState): void {
  state.target.fileContent.style.removeProperty('display');
  for (const element of state.hiddenCodeElements) {
    element.style.removeProperty('display');
  }
  state.hiddenCodeElements.clear();
}

function hideCodeDiff(state: RichDiffState): void {
  showCodeDiff(state);
  const comments = Array.from(
    state.target.fileContent.querySelectorAll<HTMLElement>('[id]'),
  ).filter((element) => /^r\d+$/.test(element.id));
  if (comments.length === 0) {
    state.target.fileContent.style.setProperty('display', 'none', 'important');
    return;
  }
  const commentRows = new Set(
    comments
      .map((comment) => comment.closest<HTMLElement>('tr'))
      .filter((row): row is HTMLElement => row !== null),
  );
  if (commentRows.size === 0) {
    state.target.fileContent.style.setProperty('display', 'none', 'important');
    return;
  }
  for (const row of state.target.fileContent.querySelectorAll<HTMLElement>('tr')) {
    if (commentRows.has(row)) continue;
    row.style.setProperty('display', 'none', 'important');
    state.hiddenCodeElements.add(row);
  }
}

function startRender(
  state: RichDiffState,
  routeState: DiffRouteState,
  force: boolean,
): void {
  if (state.resolving) return;
  state.reloadButton.disabled = true;
  state.reloadButton.setAttribute('aria-disabled', 'true');
  state.reloadButton.textContent = 'Retrying…';
  state.resolving = renderRichComparison(
    state,
    routeState,
    force,
  ).finally(() => {
    state.resolving = null;
    state.reloadButton.disabled = false;
    state.reloadButton.removeAttribute('aria-disabled');
    state.reloadButton.textContent = 'Retry';
  });
}

async function renderRichComparison(
  state: RichDiffState,
  routeState: DiffRouteState,
  force: boolean,
): Promise<void> {
  if (force) {
    state.controller?.abort();
    state.baseRender?.destroy();
    state.headRender?.destroy();
    state.baseRender = null;
    state.headRender = null;
    state.comparison = null;
    routeState.metadata = null;
    routeState.fileMetadata = null;
    routeState.sessionPullData = null;
  }
  state.retryableFailures = 0;
  const controller = new AbortController();
  state.controller = controller;
  const abort = () => controller.abort();
  routeState.controller.signal.addEventListener('abort', abort, { once: true });
  state.status.textContent = 'Loading…';
  debugLog('pr', 'rich-comparison-start', {
    path: state.target.path,
    mode: state.mode,
  });
  try {
    let comparison = state.comparison;
    if (!comparison) {
      try {
        comparison = await getDiffComparison(routeState);
      } catch (error) {
        if (!state.initialHead) throw error;
        state.baseArea.replaceChildren(
          createSideMessage('Before version unavailable.', error),
        );
      }
    }
    if (comparison) {
      state.comparison = comparison;
    }
    const head = comparison?.head ?? state.initialHead;
    if (!head) throw new Error('Diff head metadata is unavailable.');

    const jobs: Array<Promise<boolean>> = [];
    if (state.mode === 'split' && !state.baseRender) {
      if (comparison) {
        jobs.push(
          renderComparisonSide(
            state,
            'base',
            comparison.base,
            routeState,
            controller.signal,
          ),
        );
      }
    }
    if (!state.headRender) {
      jobs.push(
        renderComparisonSide(
          state,
          'head',
          head,
          routeState,
          controller.signal,
        ),
      );
    }
    await Promise.all(jobs);
    controller.signal.throwIfAborted();
    applyViewportWidth(state);
    const baseAvailable = state.baseRender !== null;
    const headAvailable = state.headRender !== null;
    state.basePane.style.display = baseAvailable ? 'flex' : 'none';
    state.headPane.style.display = headAvailable ? 'flex' : 'none';
    state.comparisonArea.style.gridTemplateColumns =
      baseAvailable && headAvailable
        ? state.container.clientWidth >= 900
          ? 'minmax(0,1fr) minmax(0,1fr)'
          : 'minmax(0,1fr)'
        : 'minmax(0,1fr)';
    state.status.textContent =
      state.retryableFailures > 0
        ? `${state.retryableFailures} resource issues`
        : !baseAvailable && !headAvailable
          ? 'Unavailable'
          : '';
    state.reloadButton.style.display =
      state.retryableFailures > 0 || (!baseAvailable && !headAvailable)
        ? 'inline-flex'
        : 'none';
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
    state.baseArea.replaceChildren(
      createSideMessage('Comparison unavailable.', error),
    );
    state.basePane.style.display = 'flex';
    state.headPane.style.display = 'none';
    state.comparisonArea.style.gridTemplateColumns = 'minmax(0,1fr)';
    state.retryableFailures += 1;
    state.reloadButton.style.display = 'inline-flex';
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
  side: DiffSide,
  routeState: DiffRouteState,
  signal: AbortSignal,
): Promise<boolean> {
  const area = sideName === 'base' ? state.baseArea : state.headArea;
  try {
    let path = state.target.path;
    let repoRef = sideRepoRef(side, path);
    let file;
    try {
      file = await fetchRepositoryFile(repoRef, signal, {
        privateRepo: side.privateRepo,
      });
    } catch (initialError) {
      const info = await getDiffFileInfo(
        routeState,
        state.target.path,
      );
      if (
        sideName === 'base' &&
        info?.status === 'renamed' &&
        info.previousFilename
      ) {
        path = info.previousFilename;
        repoRef = sideRepoRef(side, path);
        file = await fetchRepositoryFile(repoRef, signal, {
          privateRepo: side.privateRepo,
        });
      } else if (sideName === 'base' && info?.status === 'added') {
        throw new ExpectedMissingSideError(
          'File was added in this diff; no Before version exists.',
        );
      } else if (sideName === 'head' && info?.status === 'removed') {
        throw new ExpectedMissingSideError(
          'File was deleted in this diff; no After version exists.',
        );
      } else {
        throw initialError;
      }
    }
    const privateRepo = side.privateRepo || file.authenticated;
    const result = await resolveHtml(file.text, {
      target: 'sandbox-private',
      repoRef,
      privateRepo,
      signal,
    });
    signal.throwIfAborted();
    state.retryableFailures +=
      result.resources.failed + result.resources.skipped;
    const onScroll = (position: ScrollPosition) => {
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
    if (!(error instanceof ExpectedMissingSideError)) {
      state.retryableFailures += 1;
    }
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

async function getDiffComparison(
  routeState: DiffRouteState,
): Promise<DiffComparison> {
  routeState.metadata ??= fetchDiffComparison(routeState).catch((error: unknown) => {
    routeState.metadata = null;
    throw error;
  });
  return routeState.metadata;
}

async function getDiffFileInfo(
  routeState: DiffRouteState,
  path: string,
): Promise<DiffFileInfo | null> {
  routeState.fileMetadata ??= fetchDiffFiles(routeState).catch(
    (error: unknown) => {
      routeState.fileMetadata = null;
      throw error;
    },
  );
  const files = await routeState.fileMetadata;
  return (
    files.find(
      (file) =>
        file.filename === path || file.previousFilename === path,
    ) ?? null
  );
}

async function getDiffFiles(
  routeState: DiffRouteState,
): Promise<DiffFileInfo[]> {
  routeState.fileMetadata ??= fetchDiffFiles(routeState).catch(
    (error: unknown) => {
      routeState.fileMetadata = null;
      throw error;
    },
  );
  return routeState.fileMetadata;
}

async function ensureFallbackDiffCards(
  routeState: DiffRouteState,
  renderedPaths: string[],
): Promise<number> {
  const files = await getDiffFiles(routeState);
  if (routeState.controller.signal.aborted) return 0;
  const missing = files.filter(
    (file) =>
      validHtmlPath(file.filename) &&
      !renderedPaths.includes(file.filename) &&
      !document.querySelector(
        `[data-gh-html-preview-path="${CSS.escape(file.filename)}"]`,
      ),
  );
  if (missing.length === 0) return 0;
  const host = document.querySelector<HTMLElement>('main');
  if (!host) return 0;
  let list = document.querySelector<HTMLElement>(`.${FALLBACK_LIST_CLASS}`);
  if (!list) {
    list = document.createElement('div');
    list.className = FALLBACK_LIST_CLASS;
    list.style.cssText =
      'display:grid;gap:16px;width:100%;margin-block:16px;';
    host.append(list);
  }
  for (const file of missing) {
    const card = document.createElement('section');
    card.dataset.ghHtmlPreviewPath = file.filename;
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', file.filename);
    card.style.cssText =
      'overflow:hidden;border:1px solid var(--borderColor-default,#d1d9e0);border-radius:6px;background:var(--bgColor-default,#fff);';
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;gap:8px;min-height:42px;padding:6px 10px;background:var(--bgColor-muted,#f6f8fa);';
    const heading = document.createElement('h3');
    heading.style.cssText =
      'min-width:0;flex:1;margin:0;font-size:13px;font-weight:600;';
    const code = document.createElement('code');
    code.textContent = file.filename;
    heading.append(code);
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;align-items:center;';
    header.append(heading, actions);
    const headerWrapper = document.createElement('div');
    headerWrapper.append(header);
    const fileContent = document.createElement('div');
    fileContent.className = 'border';
    fileContent.textContent = 'GitHub omitted this large textual diff.';
    fileContent.style.cssText =
      'padding:16px;color:var(--fgColor-muted,#59636e);';
    card.append(headerWrapper, fileContent);
    list.append(card);
  }
  return missing.length;
}

async function fetchDiffFiles(
  routeState: DiffRouteState,
): Promise<DiffFileInfo[]> {
  const { route } = routeState;
  const { signal } = routeState.controller;
  const suffix =
    route.kind === 'pull'
      ? `pulls/${route.pullNumber}/files?per_page=100`
      : route.kind === 'commit'
        ? `commits/${encodeURIComponent(route.head)}`
        : `compare/${encodeURIComponent(route.base)}...${encodeURIComponent(route.head)}`;
  const url = `https://api.github.com/repos/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}/${suffix}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const response = await fetchWithRetry(url, {
    signal,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers,
  });
  if (!response.ok) {
    const embedded =
      route.kind === 'pull'
        ? parseEmbeddedPullFiles(await getSessionPullChangesRoute(routeState))
        : route.kind === 'commit'
          ? parseEmbeddedCommitFiles()
          : [];
    if (embedded.length > 0) return embedded;
    throw new Error(
      response.status === 404
        ? 'GitHub diff files API returned HTTP 404. Sign into GitHub and organization SSO in this tab, then try again.'
        : `GitHub diff files API returned HTTP ${response.status}.`,
    );
  }
  const data = (await response.json()) as unknown;
  const files =
    route.kind === 'pull'
      ? data
      : typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>).files
        : null;
  if (!Array.isArray(files)) {
    throw new Error('GitHub diff files API returned invalid file metadata.');
  }
  return files.flatMap((value): DiffFileInfo[] => {
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
    const visibleArea = state.baseArea;
    state.effectiveWidth.textContent = `Effective width · ${Math.round(visibleArea.getBoundingClientRect().width)} px`;
  });
}

function createComparisonPane(): {
  pane: HTMLElement;
  area: HTMLElement;
} {
  const pane = document.createElement('section');
  pane.style.cssText =
    'display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;border-right:1px solid var(--borderColor-default,#d1d9e0);';
  const area = document.createElement('div');
  area.style.cssText =
    'flex:1;min-height:0;overflow:hidden;background:var(--bgColor-default,#fff);';
  pane.append(area);
  return { pane, area };
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
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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

function sideRepoRef(side: DiffSide, path: string): RepoRef {
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
