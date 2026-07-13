# GitHub HTML Preview

Chrome extension for running and comparing commit-pinned public and private `.html` and `.htm` files directly on GitHub.

## Product behavior

- Blob pages get a **Preview** tab beside GitHub's file controls. Repository scripts run in an isolated executable frame; repository CSS and module graphs are packaged against the exact commit.
- Preview headers disclose **Executable · Scripts and network access on**. Preview code cannot access extension APIs, GitHub's parent DOM, or extension storage, but it can communicate with external services.
- **Open full preview** opens the same commit-pinned document in a dedicated executable sandbox.
- Pull-request file views get **Code diff**, **Before & after**, and **After preview** views plus **Open after preview**. Before/after uses exact base and head repositories and commits, including forks.
- Comparison tools include synchronized horizontal/vertical scrolling, Fit/Desktop/Tablet/Mobile widths, reload, fullscreen, and partial-side handling for added or deleted files.
- Public repositories need no credentials.
- Private access uses an optional fine-grained GitHub token stored in `chrome.storage.local`. Give it read-only **Contents**, **Metadata**, and **Pull requests** access only for selected repositories.
- Tokens are sent only as `Authorization` headers to `https://api.github.com`; they are never placed in URLs, preview HTML, logs, or release artifacts.

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
