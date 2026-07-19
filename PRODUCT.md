# GitHub HTML Preview — Product Specification

## Product statement

Review GitHub-hosted HTML as executable, commit-pinned artifacts directly on blob and pull-request pages—including exact base/head comparisons—inside an isolated sandbox. Public previews are credential-free; private previews use the signed-in `github.com` browser session.

## Users and jobs

1. Review generated HTML reports without cloning a repository.
2. Run interactive examples and demos from their exact commit.
3. Compare executable HTML before and after a pull request.
4. Test responsive layouts at common viewport widths.
5. Review private HTML without exposing GitHub credentials to preview code.
6. Diagnose missing repository resources and preview failures.

## Core surfaces

### Blob page

- GitHub-native Code / Preview tab relationship.
- Code remains default and recoverable.
- Preview executes scripts in an opaque sandbox.
- Repository resources resolve against exact owner, repository, ref, and path.
- Full preview opens in a dedicated extension page.

### Pull request

- **Code diff** — native GitHub source diff.
- **Before & after** — executable base/head comparison.
- **After preview** — executable head-only view.
- **Open after preview** — dedicated commit-pinned page.
- Forks use each side's exact repository and SHA.
- Comparison includes synchronized scrolling, viewport widths, reload, fullscreen, and side-specific partial states.

### Private repositories

- Private previews use the signed-in `github.com` browser session.
- The extension never asks for, accepts, or stores a personal access token.
- Repository files use GitHub's same-origin `/raw/<ref>/<path>` route with the existing browser session; GitHub may redirect to a short-lived signed `raw.githubusercontent.com` URL that the extension packages and discards.
- Session cookies remain browser-managed and are never read by extension code.
- Authenticated resources are packaged before sandbox delivery.
- Preview HTML never contains tokens, session cookies, or signed raw URLs.

## Execution model

All user-facing previews are executable. There is no hidden static mode and no DNR-based CSP relaxation.

- `sandbox.html` is the execution boundary.
- Sandbox origin is opaque; `allow-same-origin` is never granted.
- Preview code has no extension API or parent DOM access.
- Scripts and external network access are on.
- Full preview may use forms, modals, popups, and downloads.
- UI must describe this behavior accurately and never call executable preview “static” or unqualified “safe.”

## Resource model

- Public and private repository CSS and scripts are fetched at exact refs.
- Private subresources are packaged as data URLs into the sandbox.
- Public subresources are rewritten to commit-pinned CDN URLs (jsDelivr).
- Stylesheets retain activation semantics.
- Relative/root module graphs are packaged recursively.
- Bare module specifiers remain available to document import maps.
- External resources remain external.
- Resolver applies per-resource, aggregate-byte, depth, and concurrency limits.
- Failures remain visible through actionable diagnostics while usable content continues rendering.

## Reliability contract

Required release proof:

1. TypeScript compile.
2. Unit, GitHub API, resolver, privacy, performance, and manifest contracts.
3. Hermetic deterministic extension E2E.
4. Live GitHub compatibility smoke.
5. Stable and debug ZIP construction.
6. Installation and smoke test from exact ZIP artifacts.
7. Tag, package, and manifest version parity.
8. Current Playwright Chromium on supported CI operating systems.
9. Retained traces/screenshots on browser failures.

## Product principles

- Exact commit integrity over branch-latest convenience.
- Source view always recoverable.
- Executable behavior disclosed plainly.
- Failures actionable, never represented only as “Partial.”
- Private credentials stay outside executable content.
- GitHub-native interaction before separate application chrome.
- Behavioral tests over source-text assertions.
