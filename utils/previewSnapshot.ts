import { browser } from 'wxt/browser';
import type { RepoRef, ResolveResult } from './types';

const SNAPSHOT_PREFIX = 'previewSnapshot:';
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

export interface PreviewSnapshot {
  result: ResolveResult;
  repoRef: RepoRef;
  privateRepo: boolean;
}

interface StoredPreviewSnapshot extends PreviewSnapshot {
  createdAt: number;
}

export async function savePreviewSnapshot(
  result: ResolveResult,
  repoRef: Readonly<RepoRef>,
  privateRepo: boolean,
): Promise<string> {
  await removeExpiredPreviewSnapshots();
  const id = crypto.randomUUID();
  await browser.storage.session.set({
    [`${SNAPSHOT_PREFIX}${id}`]: {
      createdAt: Date.now(),
      result,
      repoRef: { ...repoRef },
      privateRepo,
    } satisfies StoredPreviewSnapshot,
  });
  return id;
}

export async function loadPreviewSnapshot(
  id: string,
): Promise<PreviewSnapshot | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const key = `${SNAPSHOT_PREFIX}${id}`;
  const stored = (await browser.storage.session.get(key))[key] as
    | StoredPreviewSnapshot
    | undefined;
  if (
    !stored ||
    Date.now() - stored.createdAt > SNAPSHOT_TTL_MS ||
    typeof stored.result?.html !== 'string' ||
    typeof stored.repoRef?.owner !== 'string' ||
    typeof stored.repoRef?.repo !== 'string' ||
    typeof stored.repoRef?.ref !== 'string' ||
    typeof stored.repoRef?.path !== 'string'
  ) {
    return null;
  }
  return {
    result: stored.result,
    repoRef: stored.repoRef,
    privateRepo: stored.privateRepo,
  };
}

export async function removePreviewSnapshot(id: string | null): Promise<void> {
  if (!id) return;
  await browser.storage.session.remove(`${SNAPSHOT_PREFIX}${id}`);
}

async function removeExpiredPreviewSnapshots(): Promise<void> {
  const stored = await browser.storage.session.get(null);
  const expired = Object.entries(stored)
    .filter(([key, value]) => {
      if (!key.startsWith(SNAPSHOT_PREFIX)) return false;
      const snapshot = value as Partial<StoredPreviewSnapshot> | null;
      return (
        typeof snapshot?.createdAt !== 'number' ||
        Date.now() - snapshot.createdAt > SNAPSHOT_TTL_MS
      );
    })
    .map(([key]) => key);
  if (expired.length > 0) await browser.storage.session.remove(expired);
}
