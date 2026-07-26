import { test, expect } from '@playwright/test';
import { launchWithExtension } from '../e2e/extensionHarness';

const owner = 'fixture';
const repo = 'ghp-annotation-poc';
const pullNumber = '1';
const prFilesUrl = `https://github.com/${owner}/${repo}/pull/${pullNumber}/files`;
const prConversationUrl = `https://github.com/${owner}/${repo}/pull/${pullNumber}`;
const anchoredCommentId = 'issuecomment-5078326898';
const guideCommentId = 'issuecomment-5078328999';
const liveTimeout = 30_000;

// 40-hex SHAs (must match /^[0-9a-f]{40}$/i).
const baseSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const headSha = '0123456789abcdef0123456789abcdef01234567';

// Anchor metadata JSON shape: {"v":1,"path":"...","anchor":{"kind":"element","css":[...]}}
// `kind` is required by decodeAnchorComment (PreviewAnchor is a discriminated union).
const indexAnchorB64 =
  'eyJ2IjoxLCJwYXRoIjoiZG9jcy9pbmRleC5odG1sIiwiYW5jaG9yIjp7ImtpbmQiOiJlbGVtZW50IiwiY3NzIjpbInAiXX19';
const guideAnchorB64 =
  'eyJ2IjoxLCJwYXRoIjoiZG9jcy9ndWlkZS5odG1sIiwiYW5jaG9yIjp7ImtpbmQiOiJlbGVtZW50IiwiY3NzIjpbImJsb2NrcXVvdGUiXX19';

// Raw markdown bodies for the anchored comments. The anchor marker is an HTML
// comment GitHub strips from rendered bodies; prAnnotations.ts recovers it from
// the logged-out `clipboard-copy[value]` attribute.
const indexRawBody = `Pinned from POC test.\n<!-- gh-html-preview-anchor:${indexAnchorB64} -->`;
const guideRawBody = `Guide callout placement looks off.\n<!-- gh-html-preview-anchor:${guideAnchorB64} -->`;

function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Two React diff cards (docs/index.html + docs/guide.html), mirroring
// githubReactPrFixture structure from e2e/extension.spec.ts.
function prFilesHtml(): string {
  const card = (filePath: string, regionId: string) => `
      <div role="region" id="${regionId}">
        <div data-diff-header-wrapper>
          <div class="DiffFileHeader">
            <div><button type="button" aria-label="Collapse file">Collapse</button></div>
            <div class="file-path">
              <h3><a href="#${regionId}"><code>${filePath}</code></a></h3>
              <button type="button" data-file-path="${filePath}">Expand all lines</button>
            </div>
            <div class="d-flex flex-row flex-justify-end flex-items-center gap-2 flex-1">
              <button type="button">More options</button>
            </div>
          </div>
        </div>
        <div class="border position-relative rounded-bottom-2">
          <table aria-label="Diff for: ${filePath}"><tbody>
            <tr data-testid="source-row"><td>Source diff</td></tr>
          </tbody></table>
        </div>
      </div>`;
  return `<!doctype html><html><body>
    <div class="PullRequestDiffsList">
      ${card('docs/index.html', 'diff-index')}
      ${card('docs/guide.html', 'diff-guide')}
    </div>
  </body></html>`;
}

// Conversation page with two issuecomment containers. Each carries the raw
// markdown (with anchor marker) in a clipboard-copy[value] attribute, matching
// the logged-out structure prAnnotations.ts parses.
function conversationHtml(): string {
  const comment = (
    id: string,
    author: string,
    body: string,
    rawBody: string,
  ) => `
    <div id="${id}">
      <div class="timeline-comment">
        <a class="author" href="/${author}">${author}</a>
        <div class="comment-body">${body}</div>
      </div>
      <clipboard-copy value="${escapeAttr(rawBody)}" aria-label="Copy markdown">
        <button type="button">Copy</button>
      </clipboard-copy>
    </div>`;
  return `<!doctype html><html><body>
    ${comment(
      anchoredCommentId,
      'poc-tester',
      'Pinned from POC test. This paragraph explains the first concept.',
      indexRawBody,
    )}
    ${comment(
      guideCommentId,
      'guide-tester',
      'Guide callout placement looks off. this callout matters.',
      guideRawBody,
    )}
  </body></html>`;
}

function rawIndexHtml(): string {
  return '<!doctype html><html><body><p>This paragraph explains the first concept</p></body></html>';
}

function rawGuideHtml(): string {
  return '<!doctype html><html><body><blockquote>this callout matters</blockquote></body></html>';
}

function pullMetadataJson(): string {
  return JSON.stringify({
    base: {
      sha: baseSha,
      repo: { full_name: `${owner}/${repo}`, private: false },
    },
    head: {
      sha: headSha,
      repo: { full_name: `${owner}/${repo}`, private: false },
    },
  });
}

function pullFilesJson(): string {
  return JSON.stringify([
    { filename: 'docs/index.html', status: 'added' },
    { filename: 'docs/guide.html', status: 'added' },
  ]);
}

test('preview annotations render pins, popovers, deep links, and propose flow', async () => {
  test.setTimeout(120_000);
  const { context, page } = await launchWithExtension();
  try {
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      const protocol = new URL(url).protocol;
      if (protocol === 'chrome-extension:') {
        await route.continue();
        return;
      }
      // PR files page.
      if (url === prFilesUrl || url === `${prFilesUrl}#`) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: prFilesHtml(),
        });
        return;
      }
      // PR conversation page (same-origin fetch from the annotation session,
      // direct navigations, and opened comment/compose tabs all land here).
      if (
        url === prConversationUrl ||
        url.startsWith(`${prConversationUrl}#`) ||
        url === `${prConversationUrl}/`
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: conversationHtml(),
        });
        return;
      }
      // PR metadata (base/head SHAs).
      if (
        url === `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pullMetadataJson(),
        });
        return;
      }
      // PR files list (statuses).
      if (
        url ===
        `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100`
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pullFilesJson(),
        });
        return;
      }
      // Raw blob for the head revision. Base (added files) returns 404.
      if (
        url ===
        `https://raw.githubusercontent.com/${owner}/${repo}/${headSha}/docs/index.html`
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: rawIndexHtml(),
        });
        return;
      }
      if (
        url ===
        `https://raw.githubusercontent.com/${owner}/${repo}/${headSha}/docs/guide.html`
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: rawGuideHtml(),
        });
        return;
      }
      if (url.startsWith(`https://raw.githubusercontent.com/${owner}/${repo}/${baseSha}/`)) {
        await route.fulfill({ status: 404, body: 'missing' });
        return;
      }
      // GitHub session raw fallback (buildGitHubSessionRawUrl) for the base
      // revision of added files must also miss, so the Before pane renders no
      // iframe (ExpectedMissingSideError) and only the After iframe remains.
      if (url.startsWith(`https://github.com/${owner}/${repo}/raw/${baseSha}/`)) {
        await route.fulfill({ status: 404, body: 'missing' });
        return;
      }
      // Fallback: any other http/https → empty 200 (no network).
      await route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    });

    await page.goto(prFilesUrl, {
      waitUntil: 'domcontentloaded',
      timeout: liveTimeout,
    });
    const previewTabs = page.getByRole('tab', { name: 'Preview' });
    await expect(previewTabs.first()).toBeVisible({ timeout: liveTimeout });
    // Both diff cards render synchronously in the synthetic fixture, but keep
    // the scroll poll to mirror the original assertion.
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, 2_000);
          return previewTabs.count();
        },
        { timeout: liveTimeout },
      )
      .toBeGreaterThanOrEqual(2);
    await page.evaluate(() => window.scrollTo(0, 0));
    // Click each diff card's Preview tab explicitly (scoped per region to avoid
    // races with virtualized/late-materialized cards).
    const regions = page.locator('[role="region"][id^="diff-"]');
    await expect(regions).toHaveCount(2, { timeout: liveTimeout });
    for (let i = 0; i < 2; i++) {
      const region = regions.nth(i);
      const previewTab = region.getByRole('tab', {
        name: 'Display before and after previews',
      });
      await expect(previewTab).toBeVisible({ timeout: liveTimeout });
      await previewTab.click();
    }

    const frame = page.frameLocator('iframe[title*="docs/index.html"]');
    const firstParagraph = frame
      .locator('p', { hasText: 'This paragraph explains the first concept' })
      .first();
    await expect(firstParagraph).toBeVisible({ timeout: liveTimeout });

    // 1. Pin from the pre-seeded anchored comment appears inside the preview.
    const pin = frame.getByRole('button', { name: '1', exact: true });
    await expect(pin).toBeVisible({ timeout: liveTimeout });
    const pinTitle = await pin.getAttribute('title');
    expect(pinTitle).toContain('Pinned from POC test');

    // 2. Pin click opens an inline popover; its action opens the GitHub
    //    comment permalink in a new tab.
    // dispatchEvent: pins reposition on scroll, so coordinate clicks race.
    await pin.dispatchEvent('click');
    const popover = frame.getByRole('dialog');
    await expect(popover).toBeVisible({ timeout: liveTimeout });
    await expect(popover).toContainText('Pinned from POC test');
    const [commentTab] = await Promise.all([
      context.waitForEvent('page', { timeout: liveTimeout }),
      popover
        .getByRole('button', { name: 'View comment on GitHub' })
        .dispatchEvent('click'),
    ]);
    expect(commentTab.url()).toContain(`#${anchoredCommentId}`);
    await commentTab.close();

    // 3. Anchors only land on their own file: the guide preview shows the
    //    guide pin anchored to its blockquote.
    const guideFrame = page.frameLocator('iframe[title*="docs/guide.html"]');
    await expect(
      guideFrame.locator('blockquote', {
        hasText: 'this callout matters',
      }),
    ).toBeVisible({ timeout: liveTimeout });
    const guidePin = guideFrame.getByRole('button', { name: '1', exact: true });
    await expect(guidePin).toBeVisible({ timeout: liveTimeout });
    expect(await guidePin.getAttribute('title')).toContain(
      'Guide callout placement looks off',
    );

    // 4. Selecting text offers a comment; submitting opens a prefilled
    //    conversation composer tab.
    await firstParagraph.evaluate((element) => {
      const selection = element.ownerDocument.getSelection();
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.ownerDocument.defaultView?.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true }),
      );
    });
    const proposeButton = frame.getByRole('button', {
      name: 'Comment',
      exact: true,
    });
    await expect(proposeButton).toBeVisible({ timeout: liveTimeout });
    await proposeButton.click();
    const composer = page.locator('.gh-html-preview-anchor-composer');
    await expect(composer).toBeVisible({ timeout: liveTimeout });
    await expect(composer).toContainText(
      'This paragraph explains the first concept',
    );
    await composer.locator('textarea').fill('POC note from Playwright.');
    const [composeTab] = await Promise.all([
      context.waitForEvent('page', { timeout: liveTimeout }),
      composer.getByRole('button', { name: 'Comment' }).click(),
    ]);
    expect(composeTab.url()).toContain('#ghp-compose-');
    await composeTab.close();

    // 5. Conversation page shows a jump button on the anchored comment.
    await page.goto(prConversationUrl, {
      waitUntil: 'domcontentloaded',
      timeout: liveTimeout,
    });
    const jump = page.getByRole('link', { name: 'Show in HTML preview' });
    await expect(jump.first()).toBeVisible({ timeout: liveTimeout });
    const href = await jump.first().getAttribute('href');
    expect(href).toContain(`/files#ghp-anchor-${anchoredCommentId}`);

    // 6. Deep link scrolls the preview to the anchored element and
    //    highlights it.
    await page.goto(`${prFilesUrl}#ghp-anchor-${anchoredCommentId}`, {
      waitUntil: 'domcontentloaded',
      timeout: liveTimeout,
    });
    const previewTabAgain = page
      .getByRole('tab', { name: 'Preview' })
      .first();
    await expect(previewTabAgain).toBeVisible({ timeout: liveTimeout });
    await previewTabAgain.click();
    const frameAgain = page.frameLocator('iframe[title*="docs/index.html"]');
    const focused = frameAgain
      .locator('p', {
        hasText: 'This paragraph explains the first concept',
      })
      .first();
    await expect(focused).toBeVisible({ timeout: liveTimeout });
    await expect
      .poll(
        async () =>
          focused.evaluate(
            (element) => (element as HTMLElement).style.outline,
          ),
        { timeout: liveTimeout },
      )
      .toContain('rgb(31, 111, 235)');
  } finally {
    await context.close();
  }
});
