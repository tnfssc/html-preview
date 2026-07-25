import { test, expect } from '@playwright/test';
import { launchWithExtension } from '../e2e/extensionHarness';

const prFilesUrl =
  'https://github.com/tnfssc/ghp-annotation-poc/pull/1/files';
const prConversationUrl =
  'https://github.com/tnfssc/ghp-annotation-poc/pull/1';
const anchoredCommentId = 'issuecomment-5078326898';
const liveTimeout = 30_000;

test.beforeAll(async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let reachable = false;
  try {
    const response = await fetch('https://github.com', {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    reachable = response.ok;
  } catch {
    reachable = false;
  } finally {
    clearTimeout(timeout);
  }
  test.skip(
    !reachable,
    'Live smoke tests require network access to github.com (offline or rate-limited).',
  );
});

test('preview annotations render pins, popovers, deep links, and propose flow', async () => {
  test.setTimeout(120_000);
  const { context, page } = await launchWithExtension();
  try {
    await page.goto(prFilesUrl, { waitUntil: 'commit', timeout: liveTimeout });
    const previewTabs = page.getByRole('tab', { name: 'Preview' });
    await expect(previewTabs.first()).toBeVisible({ timeout: liveTimeout });
    // GitHub virtualizes diff cards; scroll to materialize the second file.
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
    await previewTabs.nth(0).click();
    await previewTabs.nth(1).click();

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
      waitUntil: 'commit',
      timeout: liveTimeout,
    });
    const jump = page.getByRole('link', { name: 'Show in HTML preview' });
    await expect(jump.first()).toBeVisible({ timeout: liveTimeout });
    const href = await jump.first().getAttribute('href');
    expect(href).toContain(`/files#ghp-anchor-${anchoredCommentId}`);

    // 6. Deep link scrolls the preview to the anchored element and
    //    highlights it.
    await page.goto(`${prFilesUrl}#ghp-anchor-${anchoredCommentId}`, {
      waitUntil: 'commit',
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
