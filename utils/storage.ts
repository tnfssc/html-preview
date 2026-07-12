import { storage } from 'wxt/utils/storage';

export const enabledStorage = storage.defineItem<boolean>('local:enabled', {
  fallback: true,
});

export const githubTokenStorage = storage.defineItem<string | null>(
  'local:githubToken',
  { fallback: null },
);

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
