import { chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pathToExtension = path.join(__dirname, '../.output/chrome-mv3');

export async function launchWithExtension(): Promise<{
  context: BrowserContext;
  page: Page;
  extensionId: string;
}> {
  const context = await chromium.launchPersistentContext(
    `/tmp/playwright-gh-html-preview-${randomUUID()}`,
    {
      headless: false,
      args: [
        '--headless=new',
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
      ],
    },
  );
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('chrome://extensions');
  const extensionId = await page.evaluate(async () => {
    await customElements.whenDefined('extensions-manager');
    const manager = document.querySelector('extensions-manager');
    const managerRoot = manager?.shadowRoot;
    const itemList = managerRoot?.querySelector('extensions-item-list');
    const itemListRoot = itemList?.shadowRoot;
    const items = Array.from(itemListRoot?.querySelectorAll('extensions-item') ?? []);
    const product = items.find((item) =>
      item.shadowRoot?.textContent?.includes('GitHub HTML Preview'),
    );
    return product?.getAttribute('id') ?? null;
  });
  if (!extensionId) {
    await context.close();
    throw new Error('Loaded extension ID was not discoverable.');
  }
  return { context, page, extensionId };
}
