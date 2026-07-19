# GitHub HTML Preview

Chrome extension for running and comparing commit-pinned public and private `.html` and `.htm` files directly on GitHub.

## Product behavior

- Blob pages get a **Preview** tab beside GitHub's file controls. Repository scripts run in an isolated executable frame; repository CSS and module graphs are packaged against the exact commit.
- Preview headers disclose **Executable · Scripts and network access on**. Preview code cannot access extension APIs, GitHub's parent DOM, or extension storage, but it can communicate with external services.
- **Open full preview** opens the same commit-pinned document in a dedicated executable sandbox.
- Pull-request, commit, and release-compare file views get lightweight **Code** and **Preview** controls. Comparisons use exact base and head repositories and commits, including forks.
- Added and deleted files render whichever side exists; edited files render before and after.
- Private repository assets are packaged as data URLs into the sandbox; public repository subresources are rewritten to commit-pinned CDN URLs (jsDelivr). Both paths are commit-pinned. Fragment links stay inside the preview; links to other repository documents open the exact-ref GitHub blob in a new tab.
- Before/after scrolling uses shared HTML IDs, named anchors, and matching headings to align corresponding content. It interpolates between matched anchors and falls back to proportional document progress when no shared anchor exists.
- GitHub SPA navigation, commit-filtered PR routes, lazy `Load Diff` cards, and oversized commit/release diffs are supported. PR views use GitHub's native file cards; fallback cards are limited to commit and compare pages where GitHub omits the diff DOM.
- File collapse hides and restores active previews with GitHub's native card. Inline review comments stay visible in Preview while unrelated source rows remain hidden.
- UI stays light: show only controls required for primary preview flow. Put necessary secondary actions in a kebab menu instead of persistent toolbars, panels, or explanatory sections.
- Public repositories need no credentials.
- Private and SSO-protected repositories use the current signed-in `github.com` browser session. The extension never asks for, accepts, or stores a personal access token.
- Existing `githubToken` values from older releases are deleted automatically.
- Exact-ref raw responses are packaged in the GitHub content script. No background file tabs are opened.

## Enterprise organization SSO

Sign into GitHub and complete organization SSO in the same tab before opening Preview. No extension credential setup exists.

PR views recover base/head metadata from GitHub's embedded page data instead of requiring authenticated REST API access. Repository files use GitHub's same-origin `/raw/<ref>/<path>` route with the existing browser session. GitHub may redirect that request to a short-lived signed `raw.githubusercontent.com` URL; the extension validates the response origin and packages only response bytes.

Security boundaries:

- Session cookies remain browser-managed and are never read by extension code.
- Signed raw URLs are never placed in preview HTML, logs, storage, or diagnostics.
- Login pages and other non-raw HTML responses are rejected.
- Private fetches run only inside a `https://github.com` content script.
- Full preview receives an already packaged snapshot through `chrome.storage.session`; snapshots expire after five minutes and are removed when the source route closes.
- Self-hosted GitHub Enterprise Server domains are not currently matched; session access targets GitHub Enterprise Cloud organizations on `github.com`.

## Product requirements

- Preview behavior must survive GitHub client-side navigation without a reload.
- Blob, PR, commit, commit-filtered PR, and release-comparison routes must render exact commit-pinned HTML.
- Added and removed HTML must use one full-width pane. Never render an empty opposite pane.
- Edited HTML must render both revisions without visible **Before**, **After**, or **Ready** labels.
- Successful previews must not show resource panels or persistent diagnostics. Resource failures must remain actionable.
- Network failures and HTTP `408`, `425`, `429`, and `5xx` responses retry automatically three times with bounded exponential backoff. After exhaustion—or immediately for permanent failures—a failure-only **Retry** action clears cached metadata and refetches without reloading GitHub.
- Review comments and GitHub collapse/expand behavior must continue working in Preview.
- GitHub native and extension fallback cards must never produce duplicate previews.
- Long HTML must remain scrollable. Edited panes must synchronize semantically when stable anchors exist and proportionally otherwise.
- UI must remain visually light. Persistent controls are limited to primary actions; necessary secondary actions belong in a kebab menu.
- Private-repository support must never collect credentials or expose session cookies and signed raw URLs to preview content, logs, screenshots, or release artifacts.

## Comparison scroll synchronization

Scroll synchronization is always active for two-pane comparisons:

1. Renderer indexes unique element IDs, named anchors, and normalized headings once per document layout.
2. Scroll events identify surrounding anchors and progress between them.
3. Matching target anchors map corresponding content; progress is interpolated between matching pairs.
4. A single matching anchor preserves local pixel offset.
5. Missing anchors fall back to normalized horizontal and vertical scroll progress.
6. Programmatic target scrolling is suppressed from feeding back into source pane.

Anchor indexes rebuild after relevant DOM or layout changes and are capped to avoid unbounded work on hostile documents.

Design follows established diff-view behavior: CodeMirror aligns unchanged content in merge views, while Monaco exposes paired editor scroll and diff APIs rather than recommending raw document-pixel coupling.

- [CodeMirror merge view reference](https://codemirror.net/docs/ref/#merge.MergeView)
- [Monaco diff editor API](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor.IDiffEditor.html)
- [Monaco editor scroll API](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.ICodeEditor.html)

## Development

```bash
pnpm install
pnpm run compile
pnpm test
pnpm run test:e2e
pnpm run test:smoke
pnpm run build
pnpm run build:debug
pnpm run zip
pnpm run zip:debug
```

- `pnpm test`: resolver, GitHub API, resource-limit, and packaged-manifest contracts.
- `pnpm run test:e2e`: deterministic Chromium extension workflows with mocked GitHub pages and assets.
- `pnpm run test:smoke`: live checks against current GitHub blob and pull-request DOM.

Load `.output/chrome-mv3/` through `chrome://extensions` with Developer mode enabled.

Debug builds output to `.output/chrome-mv3-debug/`. Reproduce problems with GitHub-page and extension-page DevTools open, then filter console output by:

```text
[gh-html-preview:debug]
```

Diagnostic logs include lifecycle events, repository paths, HTTP status, resource counts, timings, and failures. They exclude tokens and file contents.

## Execution boundary

Privileged extension contexts handle local settings, authenticated GitHub API requests, and repository packaging. Executable repository content runs in `sandbox.html` with an opaque origin and without `allow-same-origin`. It cannot access extension APIs, extension storage, GitHub cookies, or the parent DOM.

Public and private repository resources are fetched at exact refs before sandbox delivery. Private resources become token-free data URLs. External resources remain external, and preview scripts can send rendered data to external services. Only preview code you trust.
