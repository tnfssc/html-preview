.

## Playwright setup

Installed:

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

## Launching Chromium with an unpacked extension

Use `chromium.launchPersistentContext` with a user data dir and pass extension flags:

```typescript
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    '--headless=new',          // required for extensions in headless mode
    `--disable-extensions-except=${pathToExtension}`,
    `--load-extension=${pathToExtension}`,
  ],
});
```

Notes:

- `headless: true` (old headless) does **not** load extensions.
- `--headless=new` with `headless: false` gives a headless browser that supports extensions.

## Inspecting service workers

MV3 extensions use service workers. Playwright can attach to them:

```typescript
const serviceWorker = await context.waitForEvent('serviceworker');
const result = await serviceWorker.evaluate(() => {
  // access chrome APIs here
});
```

We observed a race condition: `waitForEvent('serviceworker')` sometimes timed out. A reliable workaround is to wait a short delay after creating a page and then read `context.serviceWorkers()`:

```typescript
await page.waitForTimeout(2000);
const workers = context.serviceWorkers();
```

## Reading network response headers

```typescript
page.on('response', async (response) => {
  if (response.request().resourceType() === 'document') {
    console.log(response.headers()['content-security-policy']);
  }
});
```

Caveat: Chrome DevTools and Playwright's raw response header view may show stale header values due to [crbug.com/40196848](https://crbug.com/40196848). Behavior tests (e.g., "does an inline script run inside the sandbox?") are more authoritative than header inspection.

## Running the test

```bash
pnpm run test:e2e
```

Current E2E suite verifies:

- Extension service worker starts and the manifest sandbox CSP is present.
- Blob preview embeds local CSS and executable script sources in a null-origin sandbox (`sandbox="allow-scripts"`); CSS/JS/images are packaged as data URLs and external scripts remain external.
- Full preview (new tab) executes public repository scripts only inside the sandbox (`sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"`).
- Blob resources recover after automatic retries; partial previews surface actionable resource diagnostics.
- PR fork/SSO/private previews resolve exact base/head commits; private resources use only the signed-in `github.com` session (no token is requested or stored).
- GitHub SPA navigation mounts and reconciles diff controls without a location event.
- Popup enable setting updates an already-open GitHub page.
