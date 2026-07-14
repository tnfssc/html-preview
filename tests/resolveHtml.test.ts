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
  vi.unstubAllGlobals();
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

describe('resolver errors', () => {
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

    const pending = resolveHtml('<link rel="stylesheet" href="slow.css">', {
      target: 'sandbox',
      repoRef,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('omits oversized resources with actionable diagnostics', async () => {
    vi.stubGlobal(
      'location',
      new URL('https://github.com/acme/reports/blob/main/index.html'),
    );
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const response = new Response('oversized', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
      Object.defineProperty(response, 'url', { value: String(input) });
      return response;
    }) as typeof fetch;

    const result = await resolveHtml('<img id="large" src="large.png">', {
      target: 'sandbox-private',
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
        message: 'Repository resource exceeds 4 byte limit.',
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
  it('embeds public repository stylesheets while preserving executable scripts and rewriting resource URLs', async () => {
    const resources: Record<string, { body: string; type: string }> = {
      [`https://raw.githubusercontent.com/acme/reports/${repoRef.ref}/assets/site.css`]:
        {
          body: '@import "./theme.css"; .linked { background: url("./linked.png") }',
          type: 'text/css',
        },
      [`https://raw.githubusercontent.com/acme/reports/${repoRef.ref}/assets/theme.css`]:
        {
          body: '.theme { background: url("./theme.png") }',
          type: 'text/css',
        },
      [`https://raw.githubusercontent.com/acme/reports/${repoRef.ref}/assets/linked.png`]:
        { body: 'linked', type: 'image/png' },
      [`https://raw.githubusercontent.com/acme/reports/${repoRef.ref}/assets/theme.png`]:
        { body: 'theme', type: 'image/png' },
      [`https://raw.githubusercontent.com/acme/reports/${repoRef.ref}/reports/weekly/classic.js`]:
        {
          body: 'globalThis.classicLoaded = true;',
          type: 'application/javascript',
        },
      [`https://raw.githubusercontent.com/acme/reports/${repoRef.ref}/reports/weekly/app.js`]:
        {
          body:
            'import React from "react"; import "./dependency.js"; globalThis.moduleLoaded = React;',
          type: 'application/javascript',
        },
      [`https://raw.githubusercontent.com/acme/reports/${repoRef.ref}/reports/weekly/dependency.js`]:
        {
          body: 'globalThis.dependencyLoaded = true;',
          type: 'application/javascript',
        },
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const resource = resources[String(input)];
      return resource
        ? new Response(resource.body, {
            headers: { 'content-type': resource.type },
          })
        : new Response('missing', { status: 404 });
    }) as typeof fetch;
    const result = await resolveHtml(
      `<!doctype html><html><head>
        <style>.inline { background: url("./inline.png") }</style>
        <link rel="stylesheet" href="/assets/site.css" media="print" title="Printable" disabled>
      </head><body>
        <a id="fragment" href="#summary">Summary</a>
        <a id="relative" href="./details.html?print=1#summary">Details</a>
        <img id="image" src="./chart.png">
        <img id="responsive" srcset="./chart.png 1x, /assets/chart@2x.png 2x">
        <form id="form" action="/submit"><button formaction="./confirm">Send</button></form>
        <script id="inline">globalThis.previewLoaded = true;</script>
        <script id="classic" src="./classic.js"></script>
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
    expect(
      JSON.parse(
        doc.querySelector('script[type="importmap"]')?.textContent ?? '{}',
      ).imports,
    ).toMatchObject({ 'https://cdn.jsdelivr.net/': cdnRoot });
    const stylesheet = doc.querySelector<HTMLLinkElement>(
      'link[rel~="stylesheet"]',
    );
    expect(stylesheet?.getAttribute('href')).toMatch(
      /^data:text\/css;base64,/,
    );
    expect(stylesheet?.media).toBe('print');
    expect(stylesheet?.title).toBe('Printable');
    expect(stylesheet?.hasAttribute('disabled')).toBe(true);
    const stylesheetCss = decodeDataUrl(stylesheet?.href ?? '');
    expect(stylesheetCss).toContain('data:image/png;base64,bGlua2Vk');
    expect(stylesheetCss).toContain('data:image/png;base64,dGhlbWU=');
    expect(doc.querySelector('#inline')?.textContent).toContain(
      'globalThis.previewLoaded = true;',
    );
    expect(doc.querySelector('#image')?.getAttribute('src')).toBe(
      `${cdnRoot}reports/weekly/chart.png`,
    );
    expect(doc.querySelector('#responsive')?.getAttribute('srcset')).toBe(
      `${cdnRoot}reports/weekly/chart.png 1x, ${cdnRoot}assets/chart%402x.png 2x`,
    );
    expect(doc.querySelector('#relative')?.getAttribute('href')).toBe(
      `${cdnRoot}reports/weekly/details.html?print=1#summary`,
    );
    expect(doc.querySelector('#form')?.getAttribute('action')).toBe(
      `${cdnRoot}submit`,
    );
    expect(doc.querySelector('#form button')?.getAttribute('formaction')).toBe(
      `${cdnRoot}reports/weekly/confirm`,
    );
    expect(doc.querySelector('#classic')?.getAttribute('src')).toBe(
      'data:application/javascript;base64,Z2xvYmFsVGhpcy5jbGFzc2ljTG9hZGVkID0gdHJ1ZTs=',
    );
    expect(
      doc.querySelector('script[type="module"][src]')?.getAttribute('src'),
    ).toMatch(/^data:application\/javascript;base64,/);
    const publicModuleSource = decodeDataUrl(
      doc.querySelector('script[type="module"][src]')?.getAttribute('src') ??
        '',
    );
    expect(publicModuleSource).toContain('from "react"');
    expect(publicModuleSource).toContain(
      'https://private-preview.invalid/reports/weekly/dependency.js',
    );
    expect(doc.querySelector('#fragment')?.getAttribute('href')).toBe('#summary');
    const inlineCss = doc.querySelector('style')?.textContent ?? '';
    expect(inlineCss).toContain(
      `url("${cdnRoot}reports/weekly/inline.png")`,
    );
    expect(result.resources).toMatchObject({
      fetched: 7,
      inlined: 8,
      rewritten: 8,
      failed: 0,
    });
  });

  it('packages private CSS, images, classic scripts, and module graphs through the GitHub session', async () => {
    vi.stubGlobal(
      'location',
      new URL('https://github.com/acme/reports/blob/main/index.html'),
    );
    const sessionPrefix =
      `https://github.com/acme/reports/raw/${repoRef.ref}/`;
    const resources: Record<string, { body: string; type: string }> = {
      [`${sessionPrefix}assets/private.css`]: {
        body: '.hero { background: url(\"./background.png\") }',
        type: 'text/plain',
      },
      [`${sessionPrefix}assets/background.png`]: {
        body: 'background',
        type: 'application/octet-stream',
      },
      [`${sessionPrefix}reports/weekly/chart.png`]: {
        body: 'chart',
        type: 'application/octet-stream',
      },
      [`${sessionPrefix}reports/weekly/classic.js`]: {
        body: 'globalThis.classicLoaded = true;',
        type: 'application/octet-stream',
      },
      [`${sessionPrefix}reports/weekly/main.js`]: {
        body: 'import { value } from \"./dependency.js\"; globalThis.moduleValue = value;',
        type: 'application/octet-stream',
      },
      [`${sessionPrefix}reports/weekly/dependency.js`]: {
        body: 'export const value = 42;',
        type: 'application/octet-stream',
      },
    };
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      const resource = resources[url];
      const response = resource
        ? new Response(resource.body, {
            status: 200,
            headers: { 'content-type': resource.type },
          })
        : new Response('missing', { status: 404 });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }) as typeof fetch;

    const result = await resolveHtml(
      `<!doctype html><html><head>
        <link rel=\"stylesheet\" href=\"/assets/private.css\">
      </head><body>
        <img id=\"chart\" src=\"./chart.png\">
        <script id=\"inline\">globalThis.inlineScriptLoaded = true;</script>
        <script id=\"classic\" src=\"./classic.js\"></script>
        <script id=\"module\" type=\"module\" src=\"./main.js\"></script>
      </body></html>`,
      {
        target: 'sandbox-private',
        repoRef,
        privateRepo: true,
      },
    );

    const doc = new DOMParser().parseFromString(result.html, 'text/html');
    expect(
      decodeDataUrl(
        doc.querySelector<HTMLLinkElement>('link[rel~="stylesheet"]')?.href ??
          '',
      ),
    ).toContain(
      'data:image/png;base64,',
    );
    expect(doc.querySelector('#chart')?.getAttribute('src')).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(doc.querySelector('#classic')?.getAttribute('src')).toMatch(
      /^data:application\/javascript;base64,/,
    );
    expect(doc.querySelector('#inline')?.textContent).toContain(
      'globalThis.inlineScriptLoaded = true;',
    );
    expect(doc.querySelector('#module')?.getAttribute('src')).toMatch(
      /^data:application\/javascript;base64,/,
    );
    const encodedModule =
      doc.querySelector('#module')?.getAttribute('src')?.split(',')[1] ?? '';
    const moduleSource = atob(encodedModule);
    expect(moduleSource).not.toContain('./dependency.js');
    expect(moduleSource).toContain(
      'https://private-preview.invalid/reports/weekly/dependency.js',
    );
    const importMap =
      doc.querySelector('script[type="importmap"]')?.textContent ?? '';
    expect(importMap).toContain('https://private-preview.invalid/reports/weekly/dependency.js');
    expect(importMap).toContain('data:application/javascript;base64,');
    expect(result.html).not.toContain('api.github.com');
    expect(requests).toHaveLength(6);
    expect(requests.every((url) => url.startsWith(sessionPrefix))).toBe(true);
    expect(result.resources.failed).toBe(0);
  });

  it('reports unavailable private resources without a token or GitHub session', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await resolveHtml('<img src="private.png">', {
      target: 'sandbox-private',
      repoRef,
    });
    expect(result.resources.failed).toBe(1);
    expect(result.diagnostics[0]?.message).toContain(
      'signed-in GitHub browser session',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces encoded output limits before sandbox transport', async () => {
    await expect(
      resolveHtml(`<main>${'x'.repeat(512)}</main>`, {
        target: 'sandbox',
        repoRef,
        limits: { maxOutputBytes: 128 },
      }),
    ).rejects.toThrow('Resolved preview exceeds 128 byte output limit.');
  });

  it('resolves a large document within the local performance budget', async () => {
    const html = `<main>${'<section>report row</section>'.repeat(10_000)}</main>`;
    const result = await resolveHtml(html, {
      target: 'sandbox',
      repoRef,
    });

    expect(result.performance.outputBytes).toBeGreaterThan(200_000);
    expect(result.performance.resolveMs).toBeLessThan(2_000);
  });
});

function decodeDataUrl(url: string): string {
  const encoded = url.split(',')[1] ?? '';
  return atob(encoded);
}
