import { storage } from 'wxt/utils/storage';

export const enabledStorage = storage.defineItem<boolean>('local:enabled', {
  fallback: true,
});

export const githubTokenStorage = storage.defineItem<string | null>(
  'local:githubToken',
  { fallback: null },
);

export const privateFullPreviewStorage = storage.defineItem<boolean>(
  'local:privateFullPreview',
  { fallback: false },
);

export async function getSettings(): Promise<{
  enabled: boolean;
  githubToken: string | null;
  privateFullPreview: boolean;
}> {
  const [enabled, githubToken, privateFullPreview] = await Promise.all([
    enabledStorage.getValue(),
    githubTokenStorage.getValue(),
    privateFullPreviewStorage.getValue(),
  ]);
  return { enabled, githubToken, privateFullPreview };
}
