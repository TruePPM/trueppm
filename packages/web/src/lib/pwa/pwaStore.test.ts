import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InfiniteData } from '@tanstack/react-query';
import type { MyWorkPage } from '@/hooks/useMyWork';

// jsdom has no IndexedDB, so `idb` is replaced by an in-memory store with the
// three methods the module uses. The store is what the assertions read.
const rows = new Map<string, unknown>();
vi.mock('idb', () => ({
  openDB: vi.fn(() =>
    Promise.resolve({
      get: (_store: string, key: string) => Promise.resolve(rows.get(key)),
      put: (_store: string, value: { key: string }) => {
        rows.set(value.key, value);
        return Promise.resolve(value.key);
      },
      delete: (_store: string, key: string) => {
        rows.delete(key);
        return Promise.resolve();
      },
      clear: () => {
        rows.clear();
        return Promise.resolve();
      },
    }),
  ),
}));

const { loadMyWorkSnapshot, purgePwaUserData, saveMyWorkSnapshot, SNAPSHOT_TTL_MS } =
  await import('./pwaStore');

const DATA = { pages: [], pageParams: [] } as unknown as InfiniteData<MyWorkPage>;
const SAVED_AT = 1_700_000_000_000;

beforeAll(() => {
  // `idbAvailable()` checks for the global; its value is never used once `idb` is mocked.
  vi.stubGlobal('indexedDB', {});
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  rows.clear();
});

describe('loadMyWorkSnapshot — 7-day TTL (ADR-1523 §4)', () => {
  it('returns a snapshot read within the TTL', async () => {
    await saveMyWorkSnapshot('42', DATA, SAVED_AT);
    const snap = await loadMyWorkSnapshot(SAVED_AT + SNAPSHOT_TTL_MS);
    expect(snap).toMatchObject({ userId: '42', savedAt: SAVED_AT });
  });

  it('returns null for a snapshot read after the TTL', async () => {
    await saveMyWorkSnapshot('42', DATA, SAVED_AT);
    await expect(loadMyWorkSnapshot(SAVED_AT + SNAPSHOT_TTL_MS + 1)).resolves.toBeNull();
  });

  it('deletes an expired snapshot from the device when it reads one', async () => {
    await saveMyWorkSnapshot('42', DATA, SAVED_AT);
    await loadMyWorkSnapshot(SAVED_AT + SNAPSHOT_TTL_MS + 1);
    expect(rows.has('me')).toBe(false);
  });

  it('keeps a fresh snapshot on the device after reading it', async () => {
    await saveMyWorkSnapshot('42', DATA, SAVED_AT);
    await loadMyWorkSnapshot(SAVED_AT + 1);
    expect(rows.has('me')).toBe(true);
  });
});

describe('purgePwaUserData', () => {
  it('deletes the saved snapshot', async () => {
    await saveMyWorkSnapshot('42', DATA, SAVED_AT);
    await purgePwaUserData();
    expect(rows.size).toBe(0);
  });
});
