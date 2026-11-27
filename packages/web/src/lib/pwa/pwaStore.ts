/**
 * Offline read of My Work (ADR-1523 §4, #1427).
 *
 * The service worker caches no API response (ADR-1523 §2), so the offline read is
 * page-owned: each successful `/me/work/` load is written to IndexedDB with the
 * user it belongs to and the time it was saved, and read back only when the
 * network is unreachable. A 4xx/5xx is a real answer and never replaced by it.
 *
 * Bound to the user: purged on logout (via the session bridge's cache clear), on
 * user switch (the signed-in id differs from the snapshot's), and after
 * {@link SNAPSHOT_TTL_MS}. A cold offline launch cannot confirm identity, so it
 * shows the snapshot on the persisted `isAuthenticated` hint alone — the same
 * trust the shell already places in that hint — and the logout purge is what
 * keeps that safe on a shared device.
 *
 * Storage only (no React), so the session bridge can import the purge without a
 * cycle; the hook is `useMyWorkWithOfflineSnapshot`. `idb` is opened lazily inside functions so importing this module in a test or
 * non-browser environment never touches IndexedDB.
 */
import type { InfiniteData } from '@tanstack/react-query';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import axios from 'axios';
// Type-only: a value import would close a cycle through the API client, which
// imports the query client, which imports this module for the logout purge.
import type { MyWorkPage } from '@/hooks/useMyWork';

export const PWA_DB_NAME = 'trueppm-pwa';
/** Seven days: a week-old list is still useful on a job site; older is misleading. */
export const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface MyWorkSnapshot {
  key: 'me';
  userId: string;
  savedAt: number;
  data: InfiniteData<MyWorkPage>;
}

interface PwaDb extends DBSchema {
  myWorkSnapshot: { key: string; value: MyWorkSnapshot };
}

let dbPromise: Promise<IDBPDatabase<PwaDb>> | null = null;

function db(): Promise<IDBPDatabase<PwaDb>> {
  dbPromise ??= openDB<PwaDb>(PWA_DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore('myWorkSnapshot', { keyPath: 'key' });
    },
  });
  return dbPromise;
}

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export async function saveMyWorkSnapshot(
  userId: string,
  data: InfiniteData<MyWorkPage>,
  now: number = Date.now(),
): Promise<void> {
  if (!idbAvailable()) return;
  try {
    await (await db()).put('myWorkSnapshot', { key: 'me', userId, savedAt: now, data });
  } catch {
    // Storage full or blocked: the offline read is a convenience, not a contract.
  }
}

/** The stored snapshot, or null when absent, expired, or storage is unavailable. */
export async function loadMyWorkSnapshot(now: number = Date.now()): Promise<MyWorkSnapshot | null> {
  if (!idbAvailable()) return null;
  try {
    const snap = await (await db()).get('myWorkSnapshot', 'me');
    if (!snap || now - snap.savedAt > SNAPSHOT_TTL_MS) return null;
    return snap;
  } catch {
    return null;
  }
}

/** Delete everything the PWA stored for the signed-in user (logout, user switch). */
export async function purgePwaUserData(): Promise<void> {
  if (!idbAvailable()) return;
  try {
    await (await db()).clear('myWorkSnapshot');
  } catch {
    // Nothing stored, or storage unavailable: nothing to purge.
  }
}

/** True when the request never got an HTTP response (offline, DNS, refused). */
export function isNetworkFailure(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response === undefined;
}
