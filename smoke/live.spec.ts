import { test, expect } from '@playwright/test';
import { launchWithExtension } from '../e2e/extensionHarness';

const blobUrl =
  'https://github.com/mdn/learning-area/blob/main/html/introduction-to-html/getting-started/index.html';
const prUrl = 'https://github.com/mdn/learning-area/pull/846/files';
const prHtmlPath =
  'javascript/introduction-to-js-1/troubleshooting/number-game-errors.html';

test('current GitHub blob UI supports static preview', async () => {
  const { context, page } = await launchWithExtension();
  try {
    await page.goto(blobUrl, { waitUntil: 'domcontentloaded' });
    const preview = page.getByRole('tab', { name: 'Preview' });
    await expect(preview).toBeVisible({ timeout: 15_000 });
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
    await expect(container.getByRole('status')).toHaveText(/Ready|Partial/, {
      timeout: 15_000,
    });
    const frame = container
      .locator('iframe[title="Static HTML preview"]')
      .contentFrame();
    await expect(frame.getByText('This is my page')).toBeVisible();
    expect((await container.boundingBox())?.height).toBeGreaterThanOrEqual(600);
    expect(
      (
        await container
          .locator('iframe[title="Static HTML preview"]')
          .boundingBox()
      )?.height,
    ).toBeGreaterThanOrEqual(500);

    const folder = page.locator(
      '[id="html/introduction-to-html/creating-hyperlinks-item"]',
    );
    await folder.focus();
    await page.keyboard.press('ArrowRight');
    const nextFile = page.locator(
      '[id="html/introduction-to-html/creating-hyperlinks/index.html-item"] .PRIVATE_TreeView-item-content',
    );
    await expect(nextFile).toBeVisible();
    await nextFile.click();
    await expect(page).toHaveURL(/\/creating-hyperlinks\/index\.html$/);

    const refreshedFrame = page
      .locator(
        '.gh-html-preview-container iframe[title="Static HTML preview"]',
      )
      .contentFrame();
    await expect(
      refreshedFrame.getByRole('heading', {
        name: 'This is my sample homepage',
      }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tab', { name: 'Preview' })).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test('current GitHub PR UI receives HTML preview link', async () => {
  const { context, page } = await launchWithExtension();
  try {
    await page.goto(prUrl, { waitUntil: 'domcontentloaded' });
    const preview = page.getByRole('link', {
      name: `Open full preview for ${prHtmlPath}`,
    });
    await expect(preview).toBeVisible({ timeout: 20_000 });
    const href = await preview.getAttribute('href');
    expect(href).toMatch(/^chrome-extension:\/\/[^/]+\/preview\.html\?/);
    const query = new URL(href ?? '').searchParams;
    expect(query.get('path')).toBe(prHtmlPath);
    expect(query.get('ref')).toMatch(/^[0-9a-f]{40}$/i);
  } finally {
    await context.close();
  }
});
