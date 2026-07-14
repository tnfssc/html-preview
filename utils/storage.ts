import { storage } from 'wxt/utils/storage';
import { browser } from 'wxt/browser';

export const enabledStorage = storage.defineItem<boolean>('local:enabled', {
  fallback: true,
});

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

export async function purgeLegacyCredentials(): Promise<void> {
  await browser.storage.local.remove(['githubToken', 'local:githubToken']);
}

