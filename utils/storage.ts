import { storage } from 'wxt/utils/storage';

export const enabledStorage = storage.defineItem<boolean>('local:enabled', {
  fallback: true,
});

export async function getSettings(): Promise<{
  enabled: boolean;
}> {
  return { enabled: await enabledStorage.getValue() };
}
