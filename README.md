# GitHub HTML Preview

Chrome extension for previewing public and private `.html` and `.htm` files on GitHub.

## Product behavior

- Blob pages get a **Preview** tab beside GitHub's file controls.
- Inline previews are static: scripts, forms, embeds, external navigation, and external network requests are blocked. Repository CSS, images, fonts, and media are fetched and embedded locally.
- **Open full preview** runs repository HTML and JavaScript in a manifest sandbox with no extension API or parent-page access.
- Pull-request file views get **Source**, synchronized **Split**, and rendered **After** controls for changed HTML files, plus **Preview HTML** for a full-page sandbox. Split mode renders base and head commits with linked vertical/horizontal scrolling, responsive width presets, reload, and full-screen comparison. Fork PRs resolve each side against its exact repository and commit.
- Public repositories need no credentials.
- Private access uses an optional fine-grained GitHub token stored only in `chrome.storage.local`. Give it read-only **Contents**, **Metadata**, and **Pull requests** access for selected repositories.
- Executable private previews require a separate explicit opt-in because repository scripts can transmit private content to external servers.
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
pnpm run zip:debug
```

- `pnpm test`: resolver, security, resource-limit, and packaged-manifest contracts.
- `pnpm run test:e2e`: deterministic Chromium extension workflows with mocked GitHub pages and assets.
- `pnpm run test:smoke`: live checks against current GitHub blob and pull-request DOM.

Load `.output/chrome-mv3/` through `chrome://extensions` with Developer mode enabled.

Debug builds output to `.output/chrome-mv3-debug/`. Reproduce problems with GitHub-page and extension-page DevTools open, then filter console output by:

```text
[gh-html-preview:debug]
```

Diagnostic logs include lifecycle events, repository paths, HTTP status, resource counts, and failures. They exclude tokens and file contents.

## Security boundary

Privileged extension pages handle packaged code, local settings, and authenticated GitHub API requests. Executable repository content runs only in `sandbox.html`, which cannot access extension APIs or parent DOM. Inline previews carry a deny-by-default document CSP and use only embedded `data:` resources. Private CSS, images, scripts, and module graphs are fetched in the privileged context and packaged as data URLs before entering the sandbox.
