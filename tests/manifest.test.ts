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
  action?: { default_title?: string; default_popup?: string };
  content_scripts?: Array<{ js?: string[] }>;
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
    expect(manifest.background).toBeUndefined();
    expect(manifest.host_permissions).toEqual([
      '*://github.com/*',
      '*://raw.githubusercontent.com/*',
      '*://cdn.jsdelivr.net/*',
      '*://api.github.com/*',
    ]);
  });

  it('registers blob, PR, popup, and sandbox entrypoints', async () => {
    const manifest = await readManifest();
    const scripts = manifest.content_scripts?.flatMap((entry) => entry.js ?? []);
    expect(scripts).toEqual([
      'content-scripts/content.js',
      'content-scripts/pr.js',
    ]);
    expect(manifest.sandbox?.pages).toEqual(['sandbox.html']);
    expect(manifest.action).toEqual({
      default_title: 'GitHub HTML Preview',
      default_popup: 'popup.html',
    });
  });

  it('contains release-grade product identity', async () => {
    const manifest = await readManifest();
    expect(manifest.name).toBe('GitHub HTML Preview');
    expect(manifest.version).toBe('0.1.2');
  });
});
