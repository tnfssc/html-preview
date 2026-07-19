# Asset resolution for HTML previews

## The raw.githubusercontent.com problem

`raw.githubusercontent.com` serves **every** file as:

```http
content-type: text/plain; charset=utf-8
x-content-type-options: nosniff
access-control-allow-origin: *
```

Browsers refuse to:

- render HTML served as `text/plain`,
- apply CSS served as `text/plain`,
- execute JS served as `text/plain`.

So relative asset URLs inside the previewed HTML cannot simply be rewritten to raw URLs.

## Options considered

| Approach | Content types | Private repos | Notes |
|---|---|---|---|
| `raw.githubusercontent.com` | Wrong (`text/plain`) | Works with session cookie | Not usable for CSS/JS. |
| `cdn.jsdelivr.net/gh/...` | Correct (`text/css`, `application/javascript`, images native) | Public only | Fast, CORS-enabled, no backend. Best for public repos. |
| `raw.githack.com` | Serves CSS/JS as `text/html` in our checks | Public only | Unreliable / wrong types. |
| GitHub Contents API + inline/blob | Correct (we control MIME) | Works with token | More requests; can be slow for asset-heavy pages. |
| Extension-owned proxy page | Correct | Works with token | No external service, but requires opening a new tab. |

## jsDelivr details

`https://cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}`

Verified behavior:

```http
--- CSS ---
content-type: text/css; charset=utf-8
access-control-allow-origin: *

--- JS ---
content-type: application/javascript; charset=utf-8
access-control-allow-origin: *

--- HTML ---
content-type: text/plain; charset=utf-8
```

HTML is still served as `text/plain`, so we don't use jsDelivr for the root HTML document. We use it for subresources only.

## Recommended strategy

### Public repos

- Root HTML: read from GitHub's embedded JSON (`rawLines`) or fetch from `raw.githubusercontent.com`.
- Relative CSS/JS/images: rewrite to `https://cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{resolvedPath}`.

### Private repos

- Fetch each asset from `raw.githubusercontent.com` from the `github.com` content script. The request inherits the user's GitHub session cookies.
- Embed contents as `data:` URLs with the correct MIME type.
- For the inline preview, do **not** use real `blob:` URLs: the null-origin sandboxed iframe cannot read blobs scoped to `github.com`.
- For the new-tab preview page (extension origin), real `blob:` URLs work fine.

### Relative URL resolution

- Relative to the HTML file's directory.
- Root-relative (`/foo.css`) resolves to repo root.
- Protocol-relative (`//cdn.example.com/...`) becomes `https://...`.
- Honor `<base href>` if present.

## Sandbox packaging

All previews render inside a null-origin sandbox iframe (no `allow-same-origin`). Subresources are packaged before delivery rather than loaded from raw URLs:

- CSS/JS/images are embedded as `data:` URLs with correct MIME types (private path) or rewritten to commit-pinned `cdn.jsdelivr.net` URLs (public path).
- Scripts execute inside the sandbox; they are never stripped.
- External resources remain external (loaded by the sandbox's own CSP).
