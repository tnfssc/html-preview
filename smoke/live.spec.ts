import { test, expect } from '@playwright/test';
import { launchWithExtension } from '../e2e/extensionHarness';

const blobUrl =
  'https://github.com/mdn/learning-area/blob/main/html/introduction-to-html/document_and_website_structure/index.html';
const prUrl = 'https://github.com/mdn/learning-area/pull/846/files';
const prHtmlPath =
  'javascript/introduction-to-js-1/troubleshooting/number-game-errors.html';
const prHead = {
  owner: 'yousukka',
  repo: 'learning-area',
  ref: 'e5e4d64e01cb59988514779a5203b0e762c6c3a8',
};
const liveTimeout = 30_000;

test('current GitHub blob UI renders repository CSS in a sandboxed preview', async () => {
  test.setTimeout(90_000);
  const { context, page } = await launchWithExtension();
  try {
    await page.goto(blobUrl, { waitUntil: 'commit', timeout: liveTimeout });
    const preview = page.getByRole('tab', { name: 'Preview' });
    await expect(preview).toBeVisible({ timeout: liveTimeout });
    await expect(preview).toHaveCount(1, { timeout: liveTimeout });
    const blame = page.getByRole('button', { name: 'Blame' });
    expect(await preview.getAttribute('class')).toBe(
      await blame.getAttribute('class'),
    );
    const previewBox = await preview.boundingBox();
    const blameBox = await blame.boundingBox();
    expect(Math.abs((previewBox?.y ?? 0) - (blameBox?.y ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((previewBox?.height ?? 0) - (blameBox?.height ?? 0))).toBeLessThanOrEqual(1);
    await preview.click();

    const container = page.locator('.gh-html-preview-container');
    await expect(container.getByRole('status')).toBeHidden({
      timeout: liveTimeout,
    });
    const iframe = container.locator('iframe[title="Executable HTML preview"]');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts', {
      timeout: liveTimeout,
    });
    const frame = iframe.contentFrame();
    await expect(frame.getByRole('heading', { name: 'Header' })).toBeVisible({
      timeout: liveTimeout,
    });
    await expect
      .poll(
        () =>
          frame
            .locator('nav')
            .evaluate((nav) => getComputedStyle(nav).backgroundColor),
        { timeout: liveTimeout },
      )
      .toBe('rgb(255, 128, 255)');

    expect((await container.boundingBox())?.height).toBeGreaterThanOrEqual(600);
    expect((await iframe.boundingBox())?.height).toBeGreaterThanOrEqual(500);

    const folder = page.locator(
      '[id="html/introduction-to-html/creating-hyperlinks-item"]',
    );
    await folder.focus();
    await page.keyboard.press('ArrowRight');
    const nextFile = page.locator(
      '[id="html/introduction-to-html/creating-hyperlinks/index.html-item"] .PRIVATE_TreeView-item-content',
    );
    await expect(nextFile).toBeVisible({ timeout: liveTimeout });
    await nextFile.click();
    await expect(page).toHaveURL(/\/creating-hyperlinks\/index\.html$/);

    const refreshedFrame = page
      .locator(
        '.gh-html-preview-container iframe[title="Executable HTML preview"]',
      )
      .contentFrame();
    await expect(
      refreshedFrame.getByRole('heading', {
        name: 'This is my sample homepage',
      }),
    ).toBeVisible({ timeout: liveTimeout });
    await expect(page.getByRole('tab', { name: 'Preview' })).toHaveCount(1, {
      timeout: liveTimeout,
    });
  } finally {
    await context.close();
  }
});

test('current GitHub PR UI renders lightweight executable HTML diffs', async () => {
  test.setTimeout(120_000);
  const { context, page } = await launchWithExtension();
  try {
    await page.goto(prUrl, { waitUntil: 'commit', timeout: liveTimeout });
    const htmlDiff = page.locator(`[data-path="${prHtmlPath}"]`).locator('..');
    const richButton = htmlDiff.getByRole('tab', {
      name: 'Display before and after previews',
    });
    await expect(richButton).toHaveCount(1, { timeout: liveTimeout });
    await expect(
      htmlDiff.getByRole('tab', { name: 'Display code diff' }),
    ).toHaveCount(1, { timeout: liveTimeout });
    await expect(htmlDiff.locator('.js-file-content')).toBeVisible({
      timeout: liveTimeout,
    });
    await richButton.click();
    const richContainer = htmlDiff.locator('.gh-html-preview-pr-rich');
    await expect(richContainer.getByRole('status')).toBeHidden({
      timeout: liveTimeout,
    });
    await expect(richContainer.getByRole('button')).toHaveCount(0);
    await expect(richContainer.getByRole('link')).toHaveCount(0);
    const beforeIframe = richContainer.locator(
      `iframe[title="Before HTML preview for ${prHtmlPath}"]`,
    );
    const afterIframe = richContainer.locator(
      `iframe[title="After HTML preview for ${prHtmlPath}"]`,
    );
    await expect(beforeIframe).toBeVisible({ timeout: liveTimeout });
    await expect(afterIframe).toBeVisible({ timeout: liveTimeout });
    const beforeFrame = beforeIframe.contentFrame();
    await expect(
      beforeFrame.getByRole('heading', { name: 'Number guessing game' }),
    ).toBeVisible({ timeout: liveTimeout });
    const afterFrame = afterIframe.contentFrame();
    await expect(
      afterFrame.getByRole('heading', { name: 'Number guessing game' }),
    ).toBeVisible({ timeout: liveTimeout });
    await afterFrame.locator('.guessField').fill('42', {
      timeout: liveTimeout,
    });
    await afterFrame.locator('.guessSubmit').click({ timeout: liveTimeout });
    await expect(afterFrame.locator('.guesses')).toContainText(
      'Previous guesses: 42',
      { timeout: liveTimeout },
    );

    const beforeElement = await beforeIframe.elementHandle();
    const afterElement = await afterIframe.elementHandle();
    const beforePageFrame = await beforeElement?.contentFrame();
    const afterPageFrame = await afterElement?.contentFrame();
    expect(beforePageFrame).not.toBeNull();
    expect(afterPageFrame).not.toBeNull();
    await Promise.all(
      [beforePageFrame!, afterPageFrame!].map((frame) =>
        frame.evaluate(() => {
          document.documentElement.style.minWidth = '3000px';
          document.documentElement.style.minHeight = '3000px';
          document.body.style.minWidth = '3000px';
          document.body.style.minHeight = '3000px';
        }),
      ),
    );
    await beforePageFrame!.evaluate(() => scrollTo(700, 2000));
    await expect
      .poll(() => beforePageFrame!.evaluate(() => scrollY), {
        timeout: liveTimeout,
      })
      .toBeGreaterThan(1_000);
    await expect
      .poll(() => afterPageFrame!.evaluate(() => scrollY), {
        timeout: liveTimeout,
      })
      .toBeGreaterThan(1_000);
    await expect
      .poll(() => afterPageFrame!.evaluate(() => scrollX), {
        timeout: liveTimeout,
      })
      .toBeGreaterThan(300);


    await htmlDiff
      .getByRole('tab', { name: 'Display code diff' })
      .click();
    await expect(htmlDiff.locator('.js-file-content')).toBeVisible({
      timeout: liveTimeout,
    });
    await expect(richContainer).toBeHidden({ timeout: liveTimeout });
    await expect(htmlDiff.locator('.gh-html-preview-pr-controls')).toHaveCount(
      1,
      { timeout: liveTimeout },
    );
  } finally {
    await context.close();
  }
});
