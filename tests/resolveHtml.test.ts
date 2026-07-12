// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveHtml,
  resolveRepositoryUrl,
  transformSrcset,
} from '../utils/resolveHtml';
import type { RepoRef } from '../utils/types';

const repoRef: RepoRef = {
  owner: 'acme',
  repo: 'reports',
  ref: '0123456789abcdef0123456789abcdef01234567',
  path: 'reports/weekly/index.html',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('resolveRepositoryUrl', () => {
  it('models repository-root, relative, fragment, query, and external URLs', () => {
    expect(resolveRepositoryUrl('/assets/site.css', repoRef)).toMatchObject({
      kind: 'repo',
      path: 'assets/site.css',
    });
    expect(resolveRepositoryUrl('../images/chart.png', repoRef)).toMatchObject({
      kind: 'repo',
      path: 'reports/images/chart.png',
    });
    expect(resolveRepositoryUrl('#summary', repoRef)).toEqual({
      kind: 'fragment',
      value: '#summary',
    });
    expect(resolveRepositoryUrl('?print=1', repoRef)).toMatchObject({
      kind: 'repo',
      path: 'reports/weekly/index.html',
      search: '?print=1',
    });
    expect(resolveRepositoryUrl('//cdn.example.com/x.js', repoRef)).toEqual({
      kind: 'external',
      value: 'https://cdn.example.com/x.js',
    });
  });
});

describe('static preview', () => {
  it('inlines nested repository assets and blocks active or external content', async () => {
    const requests: string[] = [];
    const resources: Record<string, { body: string; type: string }> = {
      'https://raw.githubusercontent.com/acme/reports/0123456789abcdef0123456789abcdef01234567/assets/site.css':
        {
          body: '@import "./theme.css"; .hero { background: url("../images/bg.png") }',
          type: 'text/css',
        },
      'https://raw.githubusercontent.com/acme/reports/0123456789abcdef0123456789abcdef01234567/assets/theme.css':
        {
          body: '@font-face { src: url("./font.woff2") }',
          type: 'text/css',
        },
      'https://raw.githubusercontent.com/acme/reports/0123456789abcdef0123456789abcdef01234567/images/bg.png':
        { body: 'png-bytes', type: 'text/plain' },
      'https://raw.githubusercontent.com/acme/reports/0123456789abcdef0123456789abcdef01234567/assets/font.woff2':
        { body: 'font-bytes', type: 'text/plain' },
      'https://raw.githubusercontent.com/acme/reports/0123456789abcdef0123456789abcdef01234567/reports/weekly/chart.png':
        { body: 'chart-bytes', type: 'text/plain' },
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      const resource = resources[url];
      if (!resource) return new Response('missing', { status: 404 });
      return new Response(resource.body, {
        status: 200,
        headers: { 'content-type': resource.type },
      });
    }) as typeof fetch;

    const result = await resolveHtml(
      `<!doctype html><html><head>
        <link rel="stylesheet" href="/assets/site.css">
        <link rel="preload" href="https://tracker.example/pixel">
        <script>window.pwned = true</script>
        <meta http-equiv="refresh" content="0;url=https://tracker.example">
      </head><body onload="window.pwned = true">
        <img id="embedded" src="data:image/png;base64,AAAA">
        <img id="chart" src="chart.png">
        <iframe src="https://tracker.example/frame"></iframe>
        <object data="https://tracker.example/object"></object>
        <form action="https://tracker.example/post"><button formaction="https://tracker.example/other">Send</button></form>
        <a id="local" href="#summary">Summary</a>
        <a id="external" href="https://tracker.example">Tracker</a>
      </body></html>`,
      { target: 'static', repoRef },
    );

    const doc = new DOMParser().parseFromString(result.html, 'text/html');
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy" i]');
    expect(csp?.getAttribute('content')).toContain("default-src 'none'");
    expect(csp?.getAttribute('content')).toContain("connect-src 'none'");
    expect(doc.querySelectorAll('script,iframe,object,embed').length).toBe(0);
    expect(doc.querySelector('[onload]')).toBeNull();
    expect(doc.querySelector('meta[http-equiv="refresh" i]')).toBeNull();
    expect(doc.querySelector('link')).toBeNull();
    expect(doc.querySelector('form')?.hasAttribute('action')).toBe(false);
    expect(doc.querySelector('button')?.hasAttribute('formaction')).toBe(false);
    expect(doc.querySelector('#local')?.getAttribute('href')).toBe('#summary');
    expect(doc.querySelector('#external')?.hasAttribute('href')).toBe(false);
    expect(doc.querySelector('#embedded')?.getAttribute('src')).toBe(
      'data:image/png;base64,AAAA',
    );
    expect(doc.querySelector('#chart')?.getAttribute('src')).toMatch(
      /^data:image\/png;base64,/,
    );
    const css = doc.querySelector('style')?.textContent ?? '';
    expect(css).not.toContain('@import');
    expect(css).toContain('data:image/png;base64,');
    expect(css).toContain('data:font/woff2;base64,');
    expect(requests.every((url) => url.startsWith('https://raw.githubusercontent.com/acme/reports/'))).toBe(true);
    expect(requests).toHaveLength(5);
    expect(result.resources.failed).toBe(0);
  });

  it('aborts outstanding resolution', async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
        return promise;
      },
    ) as typeof fetch;

    const pending = resolveHtml('<img src="slow.png">', {
      target: 'static',
      repoRef,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('omits oversized resources with actionable diagnostics', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('oversized', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    ) as typeof fetch;

    const result = await resolveHtml('<img id="large" src="large.png">', {
      target: 'static',
      repoRef,
      limits: { maxResourceBytes: 4 },
    });
    const doc = new DOMParser().parseFromString(result.html, 'text/html');
    expect(doc.querySelector('#large')?.hasAttribute('src')).toBe(false);
    expect(result.resources.failed).toBe(1);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: 'error',
        code: 'resource-fetch-failed',
        message: 'resource exceeds 4 byte limit',
        url: 'large.png',
      }),
    ]);
  });
});

describe('srcset', () => {
  it('preserves data URLs containing commas and descriptors', async () => {
    const output = await transformSrcset(
      'data:image/png;base64,AAAA 1x, image@2x.png 2x',
      async (url) => `safe:${url}`,
    );
    expect(output).toBe(
      'safe:data:image/png;base64,AAAA 1x, safe:image@2x.png 2x',
    );
  });
});

describe('sandbox preview', () => {
  it('rewrites repository URLs, CSS imports, and root module imports to pinned CDN paths', async () => {
    const result = await resolveHtml(
      `<!doctype html><html><head>
        <style>@import "/assets/theme.css"; .hero { background: url("./hero.png") }</style>
        <link rel="stylesheet" href="/assets/site.css">
      </head><body>
        <a id="fragment" href="#summary">Summary</a>
        <img id="image" src="./chart.png">
        <script type="module" src="./app.js"></script>
      </body></html>`,
      { target: 'sandbox', repoRef },
    );

    const doc = new DOMParser().parseFromString(result.html, 'text/html');
    const cdnRoot =
      'https://cdn.jsdelivr.net/gh/acme/reports@0123456789abcdef0123456789abcdef01234567/';
    expect(doc.querySelector('base')?.href).toBe(
      `${cdnRoot}reports/weekly/`,
    );
    expect(doc.querySelector('script[type="importmap"]')?.textContent).toBe(
      JSON.stringify({ imports: { 'https://cdn.jsdelivr.net/': cdnRoot } }),
    );
    expect(doc.querySelector('link')?.href).toBe(`${cdnRoot}assets/site.css`);
    expect(doc.querySelector('#image')?.getAttribute('src')).toBe(
      `${cdnRoot}reports/weekly/chart.png`,
    );
    expect(doc.querySelector('script[type="module"][src]')?.getAttribute('src')).toBe(
      `${cdnRoot}reports/weekly/app.js`,
    );
    expect(doc.querySelector('#fragment')?.getAttribute('href')).toBe('#summary');
    const css = doc.querySelector('style')?.textContent ?? '';
    expect(css).toContain(`@import url("${cdnRoot}assets/theme.css")`);
    expect(css).toContain(
      `url("${cdnRoot}reports/weekly/hero.png")`,
    );
  });
});
