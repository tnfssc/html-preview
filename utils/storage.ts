import { storage } from 'wxt/utils/storage';

export const enabledStorage = storage.defineItem<boolean>('local:enabled', {
  fallback: true,
});

export const githubTokenStorage = storage.defineItem<string | null>(
  'local:githubToken',
  { fallback: null },
);

export interface ComparisonPreferences {
  mode: 'source' | 'split' | 'after';
  viewport: 'responsive' | '1280' | '768' | '390';
  syncScroll: boolean;
}

export const comparisonPreferencesStorage =
  storage.defineItem<ComparisonPreferences>('local:comparisonPreferences', {
    fallback: {
      mode: 'source',
      viewport: 'responsive',
      syncScroll: true,
    },
  });

export async function getSettings(): Promise<{
  enabled: boolean;
  githubToken: string | null;
}> {
  const [enabled, githubToken] = await Promise.all([
    enabledStorage.getValue(),
    githubTokenStorage.getValue(),
  ]);
  return { enabled, githubToken };
}
