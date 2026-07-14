// @vitest-environment node

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface Manifest {
  name?: string;
  version?: string;
  permissions?: string[];
  host_permissions?: string[];
  background?: unknown;
  sandbox?: { pages?: string[] };
  web_accessible_resources?: Array<{
    resources?: string[];
    matches?: string[];
    use_dynamic_url?: boolean;
  }>;
  content_security_policy?: {
    extension_pages?: string;
    sandbox?: string;
  };
  action?: { default_title?: string; default_popup?: string };
  content_scripts?: Array<{
    js?: string[];
    matches?: string[];
    run_at?: string;
  }>;
}

async function readManifest(): Promise<Manifest> {
  return JSON.parse(
    await readFile('.output/chrome-mv3/manifest.json', 'utf8'),
  ) as Manifest;
}

describe('packaged Chrome extension', () => {
  it('ships only required privileges and no background CSP modifier', async () => {
    const manifest = await readManifest();
    expect(manifest.permissions).toEqual(['storage']);
    expect(manifest.background).toEqual({
      service_worker: 'background.js',
    });
    expect(manifest.host_permissions).toEqual([
      '*://github.com/*',
      '*://raw.githubusercontent.com/*',
      '*://cdn.jsdelivr.net/*',
      '*://api.github.com/*',
    ]);
  });

  it('scopes preview access to GitHub and gives each sandbox capability a purpose', async () => {
    const manifest = await readManifest();

    expect(manifest.web_accessible_resources).toEqual([
      {
        resources: ['preview.html', 'sandbox.html'],
        matches: ['*://github.com/*'],
        use_dynamic_url: true,
      },
    ]);
    expect(manifest.sandbox?.pages).toEqual(['sandbox.html']);
    expect(manifest.content_security_policy?.extension_pages).toContain(
      "default-src 'self'",
    );
    expect(manifest.content_security_policy?.extension_pages).toContain(
      "connect-src https://api.github.com https://raw.githubusercontent.com https://cdn.jsdelivr.net",
    );
    expect(manifest.content_security_policy?.extension_pages).toContain(
      "script-src 'self'",
    );
    expect(manifest.content_security_policy?.sandbox).toContain(
      'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads',
    );
    expect(manifest.content_security_policy?.sandbox).toContain(
      'script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' data: blob: https: http:',
    );
    expect(manifest.content_security_policy?.sandbox).toContain(
      'connect-src data: blob: https: http:',
    );
  });

  it('registers GitHub document-end, popup, and sandbox entrypoints', async () => {
    const manifest = await readManifest();
    expect(manifest.content_scripts).toEqual([
      {
        matches: ['*://github.com/*'],
        run_at: 'document_end',
        js: ['content-scripts/content.js', 'content-scripts/pr.js'],
      },
    ]);
    expect(manifest.action).toEqual({
      default_title: 'GitHub HTML Preview',
      default_popup: 'popup.html',
    });
  });

  it('contains release-grade product identity', async () => {
    const manifest = await readManifest();
    const packageJson = JSON.parse(
      await readFile('package.json', 'utf8'),
    ) as { version: string };
    expect(manifest.name).toBe('GitHub HTML Preview');
    expect(manifest.version).toBe(packageJson.version);
  });
});
