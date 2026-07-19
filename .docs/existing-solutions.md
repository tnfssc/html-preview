.

## dohyeon5626/github-html-preview-extension

- Chrome Web Store extension.
- Opens HTML in a new tab.
- Uses serverless functions and `htmlpreview.github.io` as a backend proxy.
- Supports private repos via user-configured GitHub token.
- **Downside:** depends on an external server/service.

## PRO-2684/GitHub-Preview

- Server-free approach.
- Uses a service worker on a `github.io` page to intercept requests and rewrite `Content-Type`.
- Opens preview in a new tab on the project's own domain.
- **Downside:** requires navigating to the project's page first and still opens in a new tab.

## Bookmarklet by mtsknn.fi

- Reads raw HTML from `#read-only-cursor-text-area`.
- Option 1: `document.open()` / `document.write()` replaces the whole page.
- Option 2: injects `<iframe srcdoc="...">`.
- Notes that GitHub's CSP blocks iframe links.
- **Downside:** brittle, breaks GitHub client-side routing.

## raw.githack.com

- Third-party proxy that rewrites content types.
- Our checks showed it serving CSS/JS as `text/html`, which is wrong.
- **Downside:** unreliable content types, external dependency.

## GitHub Community Discussion #197070

- Proposal for native GitHub HTML preview.
- Recommends: allowlist sanitizer, bare sandbox iframe, no same-origin, served from user-content origin, explicit "Preview HTML" button.
- As of mid-2026, still just a proposal.

## What we are building differently

-- New-tab preview for PRs and for users who want a dedicated surface.
