import { test, expect, type BrowserContext } from '@playwright/test';
import { launchWithExtension } from './extensionHarness';
const commit = '0123456789abcdef0123456789abcdef01234567';
const blobUrl =
  'https://github.com/acme/reports/blob/main/reports/weekly/index.html';
const rawBase = `https://raw.githubusercontent.com/acme/reports/${commit}`;
const cdnBase = `https://cdn.jsdelivr.net/gh/acme/reports@${commit}`;
const privateBlobUrl =
  'https://github.com/private-owner/private-repo/blob/main/report/index.html';
const privateToken = 'github_pat_private_test';
const privateApiBase =
  'https://api.github.com/repos/private-owner/private-repo/contents';
const privatePrUrl =
  'https://github.com/private-owner/private-repo/pull/7/files';

const previewHtml = `<!doctype html><html><head>
  <link rel="stylesheet" href="/assets/site.css">
</head><body onload="window.inlineRan = true">
  <h2 id="script-result">Waiting for script</h2>
  <img id="chart" src="./chart.png" alt="Chart">
  <iframe src="https://tracker.example/frame"></iframe>
  <script src="./app.js"></script>
</body></html>`;

const privatePreviewHtml = `<!doctype html><html><head>
  <link rel="stylesheet" href="/assets/private.css">
</head><body>
  <h2 id="private-title">Private report</h2>
  <img id="private-image" src="./secret.png" alt="Secret chart">
  <p id="classic-result">Classic waiting</p>
  <p id="module-result">Module waiting</p>
  <script src="./classic.js"></script>
  <script type="module" src="./main.js"></script>
</body></html>`;

async function routeProductFixtures(
  context: BrowserContext,
  html = previewHtml,
): Promise<string[]> {
  const requested: string[] = [];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    requested.push(url);

    if (url === blobUrl) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: githubBlobFixture(html, commit, 'reports/weekly/index.html'),
      });
      return;
    }
    if (url === `${rawBase}/assets/site.css`) {
      await route.fulfill({
        status: 200,
        contentType: 'text/css',
        body: '.report { color: rgb(1, 2, 3) }',
      });
      return;
    }
    if (url === `${rawBase}/reports/weekly/chart.png`) {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from('chart'),
      });
      return;
    }
    if (url === `${rawBase}/reports/weekly/index.html`) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }
    if (url === `${rawBase}/reports/weekly/slow.png`) {
      await delay(400);
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from('slow'),
      });
      return;
    }
    if (url === `${cdnBase}/reports/weekly/app.js`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        headers: { 'access-control-allow-origin': '*' },
        body: `document.querySelector('#script-result').textContent = 'Script executed';`,
      });
      return;
    }
    if (url === `${cdnBase}/assets/site.css`) {
      await route.fulfill({
        status: 200,
        contentType: 'text/css',
        headers: { 'access-control-allow-origin': '*' },
        body: 'body { background: rgb(250, 250, 250) }',
      });
      return;
    }
    if (url === `${cdnBase}/reports/weekly/chart.png`) {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'access-control-allow-origin': '*' },
        body: Buffer.from('chart'),
      });
      return;
    }
    if (url.startsWith('https://tracker.example/')) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  return requested;
}

test('blob preview executes repository scripts inside sandbox', async () => {
  const { context, page } = await launchWithExtension();
  try {
    const requested = await routeProductFixtures(context);
    await page.goto(blobUrl, { waitUntil: 'domcontentloaded' });

    const previewButton = page.getByRole('tab', { name: 'Preview' });
    await expect(previewButton).toBeVisible();
    const blameButton = page.getByRole('button', { name: 'Blame' });
    expect(await previewButton.getAttribute('class')).toBe(
      await blameButton.getAttribute('class'),
    );
    const previewBox = await previewButton.boundingBox();
    const blameBox = await blameButton.boundingBox();
    expect(Math.abs((previewBox?.y ?? 0) - (blameBox?.y ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((previewBox?.height ?? 0) - (blameBox?.height ?? 0))).toBeLessThanOrEqual(1);
    await previewButton.click();

    const container = page.locator('.gh-html-preview-container');
    await expect(container.getByRole('status')).toHaveText('Ready');
    const iframe = container.locator('iframe[title="Static HTML preview"]');
    await expect(iframe).toBeVisible();
    expect((await container.boundingBox())?.height).toBeGreaterThanOrEqual(600);
    expect((await iframe.boundingBox())?.height).toBeGreaterThanOrEqual(500);
    const frame = iframe.contentFrame();
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(
            () =>
              (globalThis as typeof globalThis & { inlineRan?: boolean })
                .inlineRan,
          ),
      )
      .toBe(true);
    await expect(frame.locator('script[src]')).toHaveCount(1);
    await expect(frame.locator('#chart')).toHaveAttribute(
      'src',
      /^https:\/\/cdn\.jsdelivr\.net\//,
    );
    await expect(
      frame.locator('meta[http-equiv="Content-Security-Policy" i]'),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Code' }).click();
    await expect(container).toBeHidden();
    await expect(page.locator('.react-code-lines')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('full preview executes public repository scripts only inside sandbox', async () => {
  const { context, page, extensionId } = await launchWithExtension();
  try {
    const requested = await routeProductFixtures(context);
    await page.goto(blobUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Preview' }).click();

    const popupPromise = context.waitForEvent('page');
    await page.getByRole('link', { name: 'Open full preview' }).click();
    const fullPage = await popupPromise;
    const browserErrors: string[] = [];
    fullPage.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    fullPage.on('pageerror', (error) => browserErrors.push(error.message));
    await expect(fullPage).toHaveURL(
      new RegExp(`^chrome-extension://${extensionId}/preview\\.html\\?`),
    );
    await expect(fullPage.getByRole('status')).toHaveText('Executable preview ready.');

    const sandboxElement = await fullPage
      .locator('iframe[title="Executable HTML preview"]')
      .elementHandle();
    const sandbox = await sandboxElement?.contentFrame();
    expect(sandbox).not.toBeNull();
    await expect
      .poll(() => requested.includes(`${cdnBase}/reports/weekly/app.js`))
      .toBe(true);
    await expect.poll(() => browserErrors).toEqual([]);
    await expect(sandbox!.locator('#script-result')).toHaveText('Script executed');
    expect(
      await sandbox!.evaluate(
        () =>
          typeof (
            globalThis as typeof globalThis & {
              chrome?: { runtime?: unknown };
            }
          ).chrome?.runtime,
      ),
    ).toBe('undefined');
    expect(
      await sandbox!.evaluate(() => {
        try {
          void parent.document.body;
          return 'accessible';
        } catch {
          return 'blocked';
        }
      }),
    ).toBe('blocked');
  } finally {
    await context.close();
  }
});

test('fork PR gets one preview link for exact head repository and commit', async () => {
  const { context, page } = await launchWithExtension();
  try {
    const prUrl = 'https://github.com/acme/reports/pull/42/changes';
    const forkSha = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
    let apiRequests = 0;
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url === prUrl) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: githubPrFixture(
            'examples/demo.html',
            `/contributor/reports-fork/blob/${forkSha}/examples/demo.html`,
          ),
        });
        return;
      }
      if (url === 'https://api.github.com/repos/acme/reports/pulls/42') {
        apiRequests += 1;
        await route.fulfill({
          status: 503,
          body: 'API unavailable',
        });
        return;
      }
      if (
        url ===
        `https://raw.githubusercontent.com/contributor/reports-fork/${forkSha}/examples/demo.html`
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><html><body><h2 id="rich-pr">Rich PR HTML</h2><script>globalThis.unsafe = true</script></body></html>',
        });
        return;
      }
      await route.continue();
    });

    await page.goto(prUrl, { waitUntil: 'domcontentloaded' });
    const previewLink = page.getByRole('link', {
      name: 'Open full preview for examples/demo.html',
    });
    await expect(previewLink).toHaveCount(1);
    const href = await previewLink.getAttribute('href');
    expect(href).toMatch(/^chrome-extension:\/\/[^/]+\/preview\.html\?/);
    const query = new URL(href ?? '').searchParams;
    expect(Object.fromEntries(query)).toEqual({
      owner: 'contributor',
      repo: 'reports-fork',
      ref: forkSha,
      path: 'examples/demo.html',
    });

    const htmlDiff = page.locator('.file[data-path="examples/demo.html"]');
    const richButton = htmlDiff.getByRole('button', {
      name: 'Display the rendered PR head',
    });
    const sourceButton = htmlDiff.getByRole('button', {
      name: 'Display the source diff',
    });
    await expect(richButton).toHaveClass(/BtnGroup-item/);
    await richButton.click();
    const richContainer = htmlDiff.locator('.gh-html-preview-pr-rich');
    await expect(richContainer.getByRole('status')).toHaveText('After ready');
    const richFrame = richContainer
      .locator('iframe[title="After HTML preview for examples/demo.html"]')
      .contentFrame();
    await expect(richFrame.locator('#rich-pr')).toHaveText('Rich PR HTML');
    expect(
      await richFrame
        .locator('body')
        .evaluate(() => Reflect.has(globalThis, 'unsafe')),
    ).toBe(true);
    await expect(htmlDiff.locator('.js-file-content')).toBeHidden();
    await sourceButton.click();
    await expect(htmlDiff.locator('.js-file-content')).toBeVisible();
    await expect(richContainer).toBeHidden();

    await page.evaluate((headSha) => {
      const file = document.createElement('div');
      file.className = 'file';
      file.dataset.path = 'examples/late.htm';
      file.innerHTML =
        `<div class="file-header" data-path="examples/late.htm"><a href="/contributor/reports-fork/blob/${headSha}/examples/late.htm" data-ga-click="View file">View file</a><div class="file-actions"><div class="d-flex"></div></div></div><div class="js-file-content">Late source diff</div>`;
      document.querySelector('#files')?.appendChild(file);
    }, forkSha);
    await expect(previewLink).toHaveCount(1);
    await expect(
      page.getByRole('link', {
        name: 'Open full preview for examples/late.htm',
      }),
    ).toHaveCount(1);
    await expect(
      page
        .locator('.file[data-path="examples/late.htm"]')
        .getByRole('button', {
          name: 'Display synchronized before and after previews',
        }),
    ).toHaveCount(1);
    expect(apiRequests).toBe(0);
  } finally {
    await context.close();
  }
});

test('authenticated changes DOM receives HTML source and rich diff controls', async () => {
  const { context, page } = await launchWithExtension();
  const prUrl = 'https://github.com/acme/reports/pull/43/changes';
  const baseSha = 'abcdeabcdeabcdeabcdeabcdeabcdeabcdeabcde';
  const headSha = '1234512345123451234512345123451234512345';
  const filePath = 'examples/react-diff.html';
  let apiRequests = 0;
  let baseFileRequests = 0;
  let headFileRequests = 0;
  try {
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url === prUrl) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: githubReactPrFixture(filePath),
        });
        return;
      }
      if (url === 'https://api.github.com/repos/acme/reports/pulls/43') {
        apiRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            base: {
              sha: baseSha,
              repo: { full_name: 'acme/reports', private: false },
            },
            head: {
              sha: headSha,
              repo: { full_name: 'contributor/reports-fork', private: false },
            },
          }),
        });
        return;
      }
      if (
        url ===
        `https://raw.githubusercontent.com/acme/reports/${baseSha}/${filePath}`
      ) {
        baseFileRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><html><body style="margin:0;width:1600px;height:3000px"><h1 id="before-rich">Before version</h1><output id="before-script"></output><script>document.querySelector("#before-script").textContent = "Before script ran"</script><div style="margin-top:2800px">Before end</div></body></html>',
        });
        return;
      }
      if (
        url ===
        `https://raw.githubusercontent.com/contributor/reports-fork/${headSha}/${filePath}`
      ) {
        headFileRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><html><body style="margin:0;width:1600px;height:3000px"><h1 id="react-rich">After version</h1><output id="after-script"></output><script>document.querySelector("#after-script").textContent = "After script ran"</script><div style="margin-top:2800px">After end</div></body></html>',
        });
        return;
      }
      await route.continue();
    });

    await page.goto(prUrl, { waitUntil: 'domcontentloaded' });
    const region = page.locator('[role="region"][id^="diff-"]');
    await expect(
      region.getByRole('link', {
        name: `Open full preview for ${filePath}`,
      }),
    ).toBeVisible();
    const richButton = region.getByRole('button', {
      name: 'Display synchronized before and after previews',
    });
    await expect(richButton).toBeVisible();
    await richButton.click();
    const richContainer = region.locator('.gh-html-preview-pr-rich');
    await expect(richContainer.getByRole('status')).toHaveText(
      'Before and after ready',
    );
    const beforeIframe = richContainer.locator(
      `iframe[title="Before HTML preview for ${filePath}"]`,
    );
    const afterIframe = richContainer.locator(
      `iframe[title="After HTML preview for ${filePath}"]`,
    );
    const beforeFrame = beforeIframe.contentFrame();
    const afterFrame = afterIframe.contentFrame();
    await expect(beforeFrame.locator('#before-rich')).toHaveText(
      'Before version',
    );
    await expect(afterFrame.locator('#react-rich')).toHaveText('After version');
    await expect(beforeFrame.locator('#before-script')).toHaveText(
      'Before script ran',
    );
    await expect(afterFrame.locator('#after-script')).toHaveText(
      'After script ran',
    );
    const beforeHandle = await beforeIframe.elementHandle();
    const afterHandle = await afterIframe.elementHandle();
    const beforePageFrame = await beforeHandle?.contentFrame();
    const afterPageFrame = await afterHandle?.contentFrame();
    expect(beforePageFrame).not.toBeNull();
    expect(afterPageFrame).not.toBeNull();
    expect(
      await beforePageFrame!.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __ghHtmlPreviewScrollBridge?: boolean;
            }
          ).__ghHtmlPreviewScrollBridge,
      ),
    ).toBe(true);
    await beforePageFrame!.evaluate(() => scrollTo(700, 2000));
    expect(await beforePageFrame!.evaluate(() => scrollY)).toBeGreaterThan(1000);
    await expect
      .poll(() => afterPageFrame!.evaluate(() => scrollY))
      .toBeGreaterThan(1000);
    await expect
      .poll(() => afterPageFrame!.evaluate(() => scrollX))
      .toBeGreaterThan(300);

    await richContainer
      .getByRole('checkbox', { name: 'Synchronize preview scrolling' })
      .uncheck();
    const unsyncedY = await afterPageFrame!.evaluate(() => scrollY);
    await beforePageFrame!.evaluate(() => scrollTo(0, 0));
    await delay(200);
    expect(await afterPageFrame!.evaluate(() => scrollY)).toBe(unsyncedY);

    await richContainer
      .getByRole('combobox', { name: 'Preview viewport width' })
      .selectOption('390');
    expect((await beforeIframe.boundingBox())?.width).toBeLessThanOrEqual(390);
    expect((await afterIframe.boundingBox())?.width).toBeLessThanOrEqual(390);

    await beforeIframe.evaluate((iframe) => {
      iframe.closest('section')?.style.setProperty('display', 'none');
    });
    await richContainer.getByRole('button', { name: 'Reload' }).click();
    await expect(richContainer.getByRole('status')).toHaveText(
      'Before and after ready',
    );
    await expect(beforeIframe).toBeVisible();
    await expect(afterIframe).toBeVisible();
    await expect(beforeIframe.contentFrame().locator('#before-rich')).toHaveText(
      'Before version',
    );
    await expect(afterIframe.contentFrame().locator('#react-rich')).toHaveText(
      'After version',
    );
    expect(baseFileRequests).toBe(2);
    expect(headFileRequests).toBe(2);

    await region
      .getByRole('button', { name: 'Display the rendered PR head' })
      .click();
    await expect(beforeIframe).toBeHidden();
    await expect(afterIframe).toBeVisible();
    await expect(
      richContainer.getByRole('button', { name: 'Full screen' }),
    ).toBeVisible();
    await richContainer.getByRole('button', { name: 'Full screen' }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.fullscreenElement?.classList.contains(
            'gh-html-preview-pr-rich',
          ),
        ),
      )
      .toBe(true);
    await page.evaluate(() => document.exitFullscreen());
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null))
      .toBe(true);
    await expect(region.locator('.border')).toBeHidden();
    await region
      .getByRole('button', { name: 'Display the source diff' })
      .click();
    await expect(region.locator('.border')).toBeVisible();
    expect(apiRequests).toBe(1);
  } finally {
    await context.close();
  }
});

test('split comparison represents an added HTML file without failing head preview', async () => {
  const { context, page } = await launchWithExtension();
  const prUrl = 'https://github.com/acme/reports/pull/44/changes';
  const baseSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const headSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const filePath = 'examples/added.html';
  try {
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url === prUrl) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: githubReactPrFixture(filePath),
        });
        return;
      }
      if (url === 'https://api.github.com/repos/acme/reports/pulls/44') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            base: {
              sha: baseSha,
              repo: { full_name: 'acme/reports', private: false },
            },
            head: {
              sha: headSha,
              repo: { full_name: 'acme/reports', private: false },
            },
          }),
        });
        return;
      }
      if (
        url ===
        `https://raw.githubusercontent.com/acme/reports/${baseSha}/${filePath}`
      ) {
        await route.fulfill({ status: 404, body: 'missing' });
        return;
      }
      if (
        url ===
        `https://raw.githubusercontent.com/acme/reports/${headSha}/${filePath}`
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><html><body><h1 id="added-head">Added file</h1></body></html>',
        });
        return;
      }
      await route.continue();
    });

    await page.goto(prUrl, { waitUntil: 'domcontentloaded' });
    const region = page.locator('[role="region"][id^="diff-"]');
    await region
      .getByRole('button', {
        name: 'Display synchronized before and after previews',
      })
      .click();
    const comparison = region.locator('.gh-html-preview-pr-rich');
    await expect(comparison.getByRole('status')).toHaveText(
      'Comparison partial',
    );
    await expect(comparison).toContainText(
      'Base version unavailable. File may have been added.',
    );
    const after = comparison
      .locator(`iframe[title="After HTML preview for ${filePath}"]`)
      .contentFrame();
    await expect(after.locator('#added-head')).toHaveText('Added file');
  } finally {
    await context.close();
  }
});

test('SPA navigation renders only the newly selected file', async () => {
  const slowHtml =
    '<!doctype html><html><body><h2 id="file-a">File A</h2><img src="./slow.png"></body></html>';
  const nextHtml =
    '<!doctype html><html><body><h2 id="file-b">File B</h2></body></html>';
  const nextPath = 'reports/daily/index.html';
  const nextUrl =
    'https://github.com/acme/reports/blob/main/reports/daily/index.html';
  const { context, page } = await launchWithExtension();
  try {
    await routeProductFixtures(context, slowHtml);
    await page.goto(blobUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Preview' }).click();
    await expect(
      page.locator('.gh-html-preview-container').getByRole('status'),
    ).toHaveText('Ready');

    await page.evaluate(
      ({ url, html }) => {
        history.pushState({}, '', url);
        const source = document.querySelector('.react-code-lines');
        if (source) {
          const textarea = document.createElement('textarea');
          textarea.setAttribute('aria-label', 'file content');
          textarea.value = html;
          source.replaceChildren(textarea);
        }
        window.dispatchEvent(new Event('wxt:locationchange'));
      },
      {
        url: nextUrl,
        html: nextHtml,
      },
    );

    const nextPreview = page.getByRole('tab', { name: 'Preview' });
    await expect(nextPreview).toHaveCount(1);
    await nextPreview.click();
    const frame = page
      .locator('.gh-html-preview-container iframe[title="Static HTML preview"]')
      .contentFrame();
    await expect(frame.locator('#file-b')).toHaveText('File B');
    await expect(frame.locator('#file-a')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('popup enable setting updates an already-open GitHub page', async () => {
  const { context, page, extensionId } = await launchWithExtension();
  try {
    await routeProductFixtures(context);
    await page.goto(blobUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tab', { name: 'Preview' })).toHaveCount(1);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const enabled = popup.getByRole('checkbox', { name: 'Enable extension' });
    await expect(enabled).toBeChecked();
    await enabled.uncheck();
    await expect(popup.getByRole('status')).toHaveText('Saved');
    await expect(page.getByRole('tab', { name: 'Preview' })).toHaveCount(0);
    await expect(page.locator('.gh-html-preview-container')).toHaveCount(0);

    await enabled.check();
    await expect(popup.getByRole('status')).toHaveText('Saved');
    await expect(page.getByRole('tab', { name: 'Preview' })).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test('missing embedded source produces recoverable inline error', async () => {
  const { context, page } = await launchWithExtension();
  try {
    await context.route(`${rawBase}/reports/weekly/index.html`, async (route) => {
      await route.fulfill({ status: 503, body: 'unavailable' });
    });
    await context.route(blobUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: githubBlobFixtureWithoutSource(commit, 'reports/weekly/index.html'),
      });
    });
    await page.goto(blobUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Preview' }).click();

    const container = page.locator('.gh-html-preview-container');
    await expect(container.getByRole('status')).toHaveText('Error');
    await expect(container).toContainText('Public raw file returned HTTP 503');
    await expect(container).toContainText('Preview could not be rendered');
    await page.getByRole('button', { name: 'Code' }).click();
    await expect(page.locator('.react-code-lines')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('inline preview falls back to public raw source when embedded HTML is absent', async () => {
  const { context, page } = await launchWithExtension();
  try {
    await context.route(`${rawBase}/reports/weekly/index.html`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body><h2 id="fallback">Fallback source</h2></body></html>',
      });
    });
    await context.route(blobUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: githubBlobFixtureWithoutSource(commit, 'reports/weekly/index.html'),
      });
    });
    await page.goto(blobUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Preview' }).click();

    const container = page.locator('.gh-html-preview-container');
    await expect(container.getByRole('status')).toHaveText('Ready');
    const frame = container
      .locator('iframe[title="Static HTML preview"]')
      .contentFrame();
    await expect(frame.locator('#fallback')).toHaveText('Fallback source');
  } finally {
    await context.close();
  }
});

test('private blob and executable preview use local token without exposing it', async () => {
  const { context, page, extensionId } = await launchWithExtension();
  const authenticatedRequests: Array<{
    url: string;
    authorization: string | null;
  }> = [];
  try {
    await context.route('https://api.github.com/**', async (route) => {
      const url = route.request().url();
      const authorization = route.request().headers().authorization ?? null;
      authenticatedRequests.push({ url, authorization });
      if (url === 'https://api.github.com/user') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ login: 'private-tester' }),
        });
        return;
      }
      if (
        url ===
        'https://api.github.com/repos/private-owner/private-repo/pulls/7'
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            base: {
              sha: commit,
              repo: {
                full_name: 'private-owner/private-repo',
                private: true,
              },
            },
            head: {
              sha: commit,
              repo: {
                full_name: 'private-owner/private-repo',
                private: true,
              },
            },
          }),
        });
        return;
      }
      const resources: Record<string, { body: string; type: string }> = {
        [`${privateApiBase}/report/index.html?ref=${commit}`]: {
          body: privatePreviewHtml,
          type: 'text/html',
        },
        [`${privateApiBase}/assets/private.css?ref=${commit}`]: {
          body: 'body { color: rgb(12, 34, 56) }',
          type: 'text/plain',
        },
        [`${privateApiBase}/report/secret.png?ref=${commit}`]: {
          body: 'secret-image',
          type: 'application/octet-stream',
        },
        [`${privateApiBase}/report/classic.js?ref=${commit}`]: {
          body: `document.querySelector('#classic-result').textContent = 'Classic executed';`,
          type: 'application/octet-stream',
        },
        [`${privateApiBase}/report/main.js?ref=${commit}`]: {
          body: `import { value } from './dependency.js'; document.querySelector('#module-result').textContent = value;`,
          type: 'application/octet-stream',
        },
        [`${privateApiBase}/report/dependency.js?ref=${commit}`]: {
          body: `export const value = 'Module executed';`,
          type: 'application/octet-stream',
        },
      };
      const resource = resources[url];
      await route.fulfill(
        resource
          ? {
              status: 200,
              contentType: resource.type,
              body: resource.body,
            }
          : { status: 404, body: 'missing' },
      );
    });
    await context.route(privateBlobUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: githubBlobFixture(
          privatePreviewHtml,
          commit,
          'report/index.html',
          true,
        ),
      });
    });
    await context.route(privatePrUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: githubPrFixture('report/index.html'),
      });
    });

    await page.goto(privateBlobUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Preview' }).click();
    const container = page.locator('.gh-html-preview-container');
    await expect(container.getByRole('status')).toHaveText('Error');
    await expect(container).toContainText(
      'Private repository access requires a fine-grained GitHub token',
    );

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const tokenCreationLink = popup.getByRole('link', {
      name: 'Create fine-grained token',
    });
    await expect(tokenCreationLink).toHaveAttribute('target', '_blank');
    const tokenCreationUrl = new URL(
      (await tokenCreationLink.getAttribute('href')) ?? '',
    );
    expect(tokenCreationUrl.origin + tokenCreationUrl.pathname).toBe(
      'https://github.com/settings/personal-access-tokens/new',
    );
    expect(Object.fromEntries(tokenCreationUrl.searchParams)).toEqual({
      name: 'GitHub HTML Preview',
      description:
        'Read-only private repository access for GitHub HTML Preview',
      contents: 'read',
      metadata: 'read',
      pull_requests: 'read',
    });
    await popup.getByLabel('Private repository access').fill(privateToken);
    await popup.getByRole('button', { name: 'Save token' }).click();
    await expect(popup.getByRole('status')).toContainText(
      'Private access saved',
    );

    await expect(container.getByRole('status')).toHaveText('Ready');
    const staticFrame = container
      .locator('iframe[title="Static HTML preview"]')
      .contentFrame();
    await expect(staticFrame.locator('#private-title')).toHaveText(
      'Private report',
    );
    await expect(staticFrame.locator('#private-image')).toHaveAttribute(
      'src',
      /^data:image\/png;base64,/,
    );
    await expect(staticFrame.locator('#classic-result')).toHaveText(
      'Classic executed',
    );
    await expect(staticFrame.locator('#module-result')).toHaveText(
      'Module executed',
    );

    const popupPromise = context.waitForEvent('page');
    await page.getByRole('link', { name: 'Open full preview' }).click();
    const allowedFullPage = await popupPromise;
    const privateBrowserErrors: string[] = [];
    allowedFullPage.on('console', (message) => {
      if (message.type() === 'error') privateBrowserErrors.push(message.text());
    });
    allowedFullPage.on('pageerror', (error) =>
      privateBrowserErrors.push(error.message),
    );
    await expect(allowedFullPage.getByRole('status')).toHaveText(
      'Executable preview ready.',
    );
    const sandbox = allowedFullPage
      .locator('iframe[title="Executable HTML preview"]')
      .contentFrame();
    await expect(sandbox.locator('#classic-result')).toHaveText(
      'Classic executed',
    );
    const runtimeModuleUrl = await sandbox.locator('body').evaluate(
      (body) =>
        body.ownerDocument
          .querySelector('script[type="module"][src]')
          ?.getAttribute('src') ?? '',
    );
    const runtimeModuleSource = atob(
      runtimeModuleUrl.slice(runtimeModuleUrl.indexOf(',') + 1),
    );
    expect(runtimeModuleSource).toContain(
      'https://private-preview.invalid/report/dependency.js',
    );
    await expect.poll(() => privateBrowserErrors).toEqual([]);
    await expect(sandbox.locator('#module-result')).toHaveText(
      'Module executed',
    );
    expect(await allowedFullPage.content()).not.toContain(privateToken);
    expect(
      authenticatedRequests.every(
        ({ url, authorization }) =>
          url.startsWith('https://api.github.com/') &&
          authorization === `Bearer ${privateToken}`,
      ),
    ).toBe(true);
    expect(
      authenticatedRequests.every(({ url }) => !url.includes(privateToken)),
    ).toBe(true);

    const prPage = await context.newPage();
    await prPage.goto(privatePrUrl, { waitUntil: 'domcontentloaded' });
    const privatePrLink = prPage.getByRole('link', {
      name: 'Open full preview for report/index.html',
    });
    await expect(privatePrLink).toBeVisible();
    const privatePrQuery = new URL(
      (await privatePrLink.getAttribute('href')) ?? '',
    ).searchParams;
    expect(privatePrQuery.get('private')).toBe('1');
    expect(privatePrQuery.get('ref')).toBe(commit);
    expect(
      authenticatedRequests.some(
        ({ url, authorization }) =>
          url.endsWith('/repos/private-owner/private-repo/pulls/7') &&
          authorization === `Bearer ${privateToken}`,
      ),
    ).toBe(true);

    const privateDiff = prPage.locator(
      '.file[data-path="report/index.html"]',
    );
    await privateDiff
      .getByRole('button', {
        name: 'Display synchronized before and after previews',
      })
      .click();
    const privateComparison = privateDiff.locator(
      '.gh-html-preview-pr-rich',
    );
    await expect(privateComparison.getByRole('status')).toHaveText(
      'Before and after ready',
    );
    await expect(
      privateComparison
        .locator('iframe[title^="Before HTML preview"]')
        .contentFrame()
        .locator('#private-title'),
    ).toHaveText('Private report');
    await expect(
      privateComparison
        .locator('iframe[title^="After HTML preview"]')
        .contentFrame()
        .locator('#private-title'),
    ).toHaveText('Private report');
  } finally {
    await context.close();
  }
});

function githubBlobFixture(
  html: string,
  oid: string,
  filePath: string,
  isPrivate = false,
): string {
  const payload = githubEmbeddedPayload(html, oid, filePath, isPrivate);
  return `<!doctype html><html><head><style>
    ul.SegmentedControl { display: flex; margin: 0; padding: 0; list-style: none; }
    .native-segment { display: block; }
    .native-segment-button { height: 32px; padding: 5px 12px; }
  </style></head><body>
    <main id="blob">
      <div class="react-blob-view-header-sticky">
        <ul class="SegmentedControl" aria-label="File view">
          <li class="native-segment" data-selected data-component="SegmentedControl.Button">
            <button class="native-segment-button" type="button" aria-current="true" style="--separator-color:transparent">
              <span class="segmentedControl-content"><span class="segmentedControl-text" data-text="Code">Code</span></span>
            </button>
          </li>
          <li class="native-segment" data-component="SegmentedControl.Button">
            <button class="native-segment-button" type="button" aria-current="false" style="--separator-color:var(--borderColor-default)">
              <span class="segmentedControl-content"><span class="segmentedControl-text" data-text="Blame">Blame</span></span>
            </button>
          </li>
        </ul>
      </div>
      <div id="source"><div class="react-code-lines">Source code</div></div>
    </main>
    <script type="application/json" data-target="react-app.embeddedData">${payload}</script>
  </body></html>`;
}

function githubEmbeddedPayload(
  html: string,
  oid: string,
  filePath: string,
  isPrivate = false,
): string {
  return JSON.stringify({
    payload: {
      repo: {
        ownerLogin: isPrivate ? 'private-owner' : 'acme',
        name: isPrivate ? 'private-repo' : 'reports',
        isPrivate,
      },
      refInfo: { currentOid: oid, name: 'main' },
      path: filePath,
      'codeViewBlobLayoutRoute.StyledBlob': {
        path: filePath,
        rawLines: html.split('\n'),
      },
    },
  }).replaceAll('<', '\\u003c');
}

function githubPrFixture(filePath: string, viewFileHref?: string): string {
  return `<!doctype html><html><body><div id="files">
    <div class="file" data-path="${filePath}">
      <div class="file-header" data-path="${filePath}">
        ${
          viewFileHref
            ? `<a href="${viewFileHref}" data-ga-click="View file">View file</a>`
            : ''
        }
        <div class="file-actions"><div class="d-flex"></div></div>
      </div>
      <div class="js-file-content">Source diff for ${filePath}</div>
    </div>
  </div></body></html>`;
}

function githubReactPrFixture(filePath: string): string {
  return `<!doctype html><html><body>
    <div class="PullRequestDiffsList">
      <div role="region" id="diff-authenticated-react">
        <div data-diff-header-wrapper>
          <div class="DiffFileHeader">
            <div><button type="button">Collapse</button></div>
            <div class="file-path">
              <h3><a href="#diff-authenticated-react"><code>${filePath}</code></a></h3>
              <button type="button" data-file-path="${filePath}">Expand all lines</button>
            </div>
            <div class="d-flex flex-row flex-justify-end flex-items-center gap-2 flex-1">
              <button type="button">More options</button>
            </div>
          </div>
        </div>
        <div class="border position-relative rounded-bottom-2">
          <table aria-label="Diff for: ${filePath}"><tbody><tr><td>Source diff</td></tr></tbody></table>
        </div>
      </div>
    </div>
  </body></html>`;
}

function githubBlobFixtureWithoutSource(oid: string, filePath: string): string {
  const payload = JSON.stringify({
    payload: {
      repo: { ownerLogin: 'acme', name: 'reports' },
      refInfo: { currentOid: oid, name: 'main' },
      path: filePath,
      'codeViewBlobLayoutRoute.StyledBlob': { path: filePath },
    },
  });
  return `<!doctype html><html><body>
    <main id="blob">
      <div class="react-blob-view-header-sticky">
        <ul class="SegmentedControl" aria-label="File view">
          <li><button type="button" aria-selected="true">Code</button></li>
          <li><button type="button" aria-selected="false">Blame</button></li>
        </ul>
      </div>
      <div id="source"><div class="react-code-lines">Source code</div></div>
    </main>
    <script type="application/json" data-target="react-app.embeddedData">${payload}</script>
  </body></html>`;
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}
