// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { encodeAnchorComment } from '../utils/annotations';
import {
  anchorsFromSources,
  collectCommentSources,
  encodeComposeHash,
} from '../utils/prAnnotations';

const coordinate = { owner: 'octo', repo: 'demo', pullNumber: '7' };

function scan(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const sources = collectCommentSources(doc);
  return anchorsFromSources(sources, new Map(), coordinate);
}

function conversationHtml(markerComment: string): string {
  return `<html><body>
    <div id="issuecomment-123" class="js-comment-container">
      <a class="author">monalisa</a>
      <div class="comment-body"><p>Pinned wording is off.</p></div>
      <clipboard-copy value="Pinned wording is off.

${markerComment.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')}
"></clipboard-copy>
    </div>
    <div id="issuecomment-999" class="js-comment-container">
      <a class="author">hubot</a>
      <div class="comment-body"><p>Plain comment without metadata.</p></div>
      <clipboard-copy value="Plain comment without metadata."></clipboard-copy>
    </div>
  </body></html>`;
}

describe('conversation anchor scanning', () => {
  it('extracts anchors from clipboard-copy raw markdown', () => {
    const metadata = {
      v: 1 as const,
      path: 'docs/index.html',
      anchor: { kind: 'element' as const, css: ['div'] },
    };
    const anchors = scan(
      conversationHtml(encodeAnchorComment(metadata)),
    );
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toEqual({
      id: 'issuecomment-123',
      path: 'docs/index.html',
      anchor: { kind: 'element', css: ['div'] },
      excerpt: 'Pinned wording is off.',
      author: 'monalisa',
      url: 'https://github.com/octo/demo/pull/7#issuecomment-123',
    });
  });

  it('ignores comments without markers or with corrupt metadata', () => {
    expect(
      scan(
      conversationHtml('<!-- gh-html-preview-anchor:corrupt!!! -->'),
      ),
    ).toEqual([]);
  });

  it('resolves anchors from cached edit_form bodies when clipboard-copy is absent', () => {
    const metadata = {
      v: 1 as const,
      path: 'docs/guide.html',
      anchor: { kind: 'element' as const, css: ['blockquote'] },
    };
    const raw = `Guide callout is off.\n\n${encodeAnchorComment(metadata)}`;
    const html = `<html><body>
      <div id="issuecomment-456" class="js-comment-container">
        <a class="author">monalisa</a>
        <div class="comment-body"><p>Guide callout is off.</p></div>
        <include-fragment src="/octo/demo/issue_comments/456/edit_form?textarea_id=issuecomment-456-body"></include-fragment>
      </div>
    </body></html>`;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const sources = collectCommentSources(doc);
    expect(sources).toHaveLength(1);
    expect(sources[0].rawBody).toBeNull();
    expect(sources[0].editFormPath).toContain('/issue_comments/456/edit_form');
    const bodies = new Map([['issuecomment-456', raw]]);
    const anchors = anchorsFromSources(sources, bodies, coordinate);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].path).toBe('docs/guide.html');
    expect(anchors[0].author).toBe('monalisa');
  });

  it('ignores permalink elements that merely share the id prefix', () => {
    const metadata = {
      v: 1 as const,
      path: 'a.html',
      anchor: { kind: 'element' as const, css: ['div'] },
    };
    const raw = `Note.\n\n${encodeAnchorComment(metadata)}`;
    const html = `<html><body>
      <div id="issuecomment-123" class="js-comment-container">
        <a id="issuecomment-123-permalink" class="author">monalisa</a>
        <div class="comment-body"><p>Note.</p></div>
        <clipboard-copy value="${raw.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')}"></clipboard-copy>
      </div>
    </body></html>`;
    expect(scan(html)).toHaveLength(1);
  });
});

describe('compose hash encoding', () => {
  it('produces a fragment-safe hash without double hyphens', () => {
    const hash = encodeComposeHash({
      path: 'docs/index.html',
      body: 'Text — with ünicode\n\n<!-- gh-html-preview-anchor:abc -->',
    });
    expect(hash.startsWith('#ghp-compose-')).toBe(true);
    expect(hash).not.toContain('--');
    expect(hash).not.toMatch(/[+/=\s]/);
  });
});
