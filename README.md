# GitHub HTML Preview

Chrome extension for previewing public `.html` and `.htm` files on GitHub.

## Product behavior

- Blob pages get a **Preview** tab beside GitHub's file controls.
- Inline previews are static: scripts, forms, embeds, external navigation, and external network requests are blocked. Repository CSS, images, fonts, and media are fetched and embedded locally.
- **Open full preview** runs public repository HTML and JavaScript in a manifest sandbox with no extension API or parent-page access.
- Pull-request file views get a **Preview** link for changed HTML files. Fork PRs resolve against the fork repository and exact head commit.
- Current release supports public repositories on Chrome MV3. It does not request GitHub credentials or remove GitHub security headers.

## Development

```bash
pnpm install
pnpm run compile
pnpm test
pnpm run test:e2e
pnpm run test:smoke
pnpm run build
```

- `pnpm test`: resolver, security, resource-limit, and packaged-manifest contracts.
- `pnpm run test:e2e`: deterministic Chromium extension workflows with mocked GitHub pages and assets.
- `pnpm run test:smoke`: live checks against current GitHub blob and pull-request DOM.

Load `.output/chrome-mv3/` through `chrome://extensions` with Developer mode enabled.

## Security boundary

Privileged extension pages handle packaged code, settings, and public file fetches. Executable repository content runs only in `sandbox.html`, which cannot access extension APIs or parent DOM. Inline previews carry a deny-by-default document CSP and use only embedded `data:` resources.
