import { chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pathToExtension =
  process.env.EXTENSION_PATH ?? path.join(__dirname, '../.output/chrome-mv3');

const EXTENSION_ID_DISCOVERY_TIMEOUT_MS = 15_000;

export async function launchWithExtension(): Promise<{
  context: BrowserContext;
  page: Page;
  extensionId: string;
}> {
  const profileDir = `/tmp/playwright-gh-html-preview-${randomUUID()}`;
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    recordVideo: process.env.RECORD_E2E
      ? {
          dir: process.env.E2E_VIDEO_DIR ?? 'test-results/e2e-videos',
          size: { width: 1280, height: 720 },
        }
      : undefined,
    args: [
      '--headless=new',
      `--disable-extensions-except=${pathToExtension}`,
      `--load-extension=${pathToExtension}`,
    ],
  });

  // Wrap close() so the persistent profile directory is cleaned up even when
  // callers close the context without knowing the profile path. This keeps the
  // return shape unchanged and requires zero caller changes.
  const cleanupProfile = () => rmSync(profileDir, { recursive: true, force: true });
  const originalClose = context.close.bind(context);
  context.close = async function () {
    try {
      await originalClose();
    } finally {
      cleanupProfile();
    }
  };

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('chrome://extensions');

  const discoverExtensionId = page.evaluate(async () => {
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

  let extensionId: string | null;
  try {
    extensionId = await Promise.race([
      discoverExtensionId,
      new Promise<null>((resolve) =>
        setTimeout(
          () => resolve(null),
          EXTENSION_ID_DISCOVERY_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (error) {
    await context.close();
    throw error;
  }

  if (!extensionId) {
    await context.close();
    throw new Error(
      'chrome://extensions UI changed — extension ID not discoverable within ' +
        `${EXTENSION_ID_DISCOVERY_TIMEOUT_MS}ms.`,
    );
  }
  return { context, page, extensionId };
}
