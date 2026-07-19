# GitHub CSP and iframe policy

## Verified response headers on `github.com/*/blob/*`

```http
x-frame-options: deny
content-security-policy:
  default-src 'none';
  base-uri 'self';
  child-src github.githubassets.com github.com/assets-cdn/worker/ github.com/assets/ gist.github.com/assets-cdn/worker/;
  connect-src 'self' uploads.github.com www.githubstatus.com collector.github.com raw.githubusercontent.com api.github.com ...;
  font-src github.githubassets.com;
  form-action 'self' github.com gist.github.com ...;
  frame-ancestors 'none';
  frame-src viewscreen.githubusercontent.com notebooks.githubusercontent.com;
  img-src 'self' data: blob: *.githubusercontent.com ...;
  manifest-src 'self';
  media-src github.com user-images.githubusercontent.com ...;
  script-src github.githubassets.com;
  style-src 'unsafe-inline' github.githubassets.com;
  upgrade-insecure-requests;
  worker-src github.githubassets.com github.com/assets-cdn/worker/ github.com/assets/ gist.github.com/assets-cdn/worker/;
```

## Implications

- `github.com` cannot be framed by anyone (`frame-ancestors 'none'`).
- Arbitrary URLs cannot be loaded in `<iframe src>` on a GitHub page (`frame-src` is restricted to GitHub-controlled origins).
- `fetch()` from the content script to `raw.githubusercontent.com` and `api.github.com` is allowed because both are in `connect-src`.
- An iframe without a network URL avoids `frame-src` entirely. The right primitive is `<iframe srcdoc="..." sandbox="...">`.

## `srcdoc` iframe CSP inheritance

The extension never modifies GitHub's CSP — there is no `declarativeNetRequest` usage and no static/full mode split.

Observed behavior:

| Resource type | Behavior under inherited GitHub CSP |
|---|---|
| Inline `<style>` | ✅ Works (`style-src 'unsafe-inline'`) |
| Inline `<script>` | ❌ Blocked by GitHub's `script-src` (no `'unsafe-inline'`) — scripts run inside the opaque-origin sandbox iframe, not the main page |
| External stylesheet (`cdn.jsdelivr.net`) | ❌ Blocked by `style-src` — rewrite to inlined `<style>` / data URL / commit-pinned CDN inside the sandbox |
| Data-URL stylesheet | ❌ Blocked in the main page — packaged into the sandbox iframe instead |
| Image from `*.githubusercontent.com` | ✅ Loads (`img-src` allowlist) |
| Image `data:` URL | ✅ Loads (`img-src` includes `data:`) |

With `sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"` and **no** `allow-same-origin`, the iframe gets an opaque origin. It cannot access `github.com` cookies/DOM, but scripts can run, forms submit, and popups open.

## References

- GitHub Community proposal for native HTML preview: Discussion #197070
