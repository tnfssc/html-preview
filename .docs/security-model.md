# Security model

## Threat model

The extension renders arbitrary user-controlled HTML from public or private GitHub repos. We assume the HTML is hostile.

## Isolation primitives

### Sandboxed `srcdoc` iframe

```html
<iframe srcdoc="..." sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads">
```

- **No `allow-same-origin`:** the iframe gets an opaque/null origin. It cannot access `github.com` cookies, DOM, or storage.
- **`allow-scripts`:** scripts run inside the iframe.
- **`allow-forms`:** forms can submit (full preview only).
- **`allow-modals` / `allow-popups`:** `<a target="_blank">` and `window.open` open in a new tab outside the iframe; `alert`/`confirm` work.
- **`allow-downloads`:** triggered downloads are permitted.
- **No `allow-top-navigation`:** the iframe cannot navigate the top-level GitHub tab.

## Execution model

All user-facing previews are executable. There is no static mode and no DNR-based CSP relaxation — GitHub's response headers are never modified.

| Surface | CSP handling | Scripts | External CSS | Use case |
|---|---|---|---|---|
| Blob inline preview | GitHub CSP stays active; iframe is `srcdoc` with `allow-scripts` (no `allow-same-origin`) | Yes (sandbox-isolated) | Inlined / data URLs / commit-pinned CDN | Default blob preview |
| New tab / PR preview | Extension sandbox page (`sandbox.html`), no GitHub CSP | Yes | jsDelivr / data / blob URLs | PRs and full previews |

The sandbox CSP (declared in `wxt.config.ts`) grants `allow-scripts allow-forms allow-modals allow-popups allow-downloads` and a permissive subresource policy scoped to the opaque sandbox origin. `allow-same-origin` is never granted.

## Credential isolation

- The `srcdoc` and sandbox-page iframes are null-origin and cannot read GitHub's cookies.
- Content script `fetch()` to `raw.githubusercontent.com` inherits the user's GitHub session cookies, enabling private-repo access without any token.
- The extension never requests, inputs, or stores a GitHub token. Private previews rely solely on the signed-in `github.com` browser session.

## Store policy risks

- No security headers are modified. The extension does not relax GitHub's CSP, so Mozilla Add-ons and Chrome Web Store CSP-relaxation concerns do not apply.
- Arbitrary script execution happens inside an opaque-origin sandbox with no parent DOM, cookie, or extension API access. The UI discloses this executable behavior plainly and never labels executable preview as "static" or unqualified "safe."

## Recommendations

- Always render in a null-origin sandbox; never grant `allow-same-origin`.
- Describe executable behavior accurately in the UI.
- Offer a new-tab full preview for users who want a dedicated surface.
- Resolve every repository resource against an exact ref (commit SHA).
