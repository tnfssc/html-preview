import { describe, expect, it } from 'vitest';
import { redactDebugText } from '../utils/debug';

describe('debug privacy', () => {
  it('redacts fine-grained, classic, and bearer credentials', () => {
    const output = redactDebugText(
      'github_pat_1234567890ABCDEF ghp_1234567890ABCDEF Authorization: Bearer secret-token',
    );

    expect(output).toBe(
      '[REDACTED] [REDACTED] Authorization: Bearer [REDACTED]',
    );
    expect(output).not.toContain('1234567890ABCDEF');
    expect(output).not.toContain('secret-token');
  });

  it('keeps useful non-secret diagnostics intact', () => {
    expect(
      redactDebugText('HTTP 404 reports/weekly/index.html'),
    ).toBe('HTTP 404 reports/weekly/index.html');
  });
});
