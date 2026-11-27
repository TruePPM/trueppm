/**
 * My Work with the offline fallback (ADR-1523 §4, #1427). See `lib/pwa/pwaStore`
 * for the storage rules (user binding, TTL, purge).
 */
import { useEffect, useState } from 'react';
import { useMyWork, type MyWorkPage } from '@/hooks/useMyWork';
import type { InfiniteData } from '@tanstack/react-query';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { isSameUser } from '@/lib/userId';
import {
  isNetworkFailure,
  loadMyWorkSnapshot,
  purgePwaUserData,
  saveMyWorkSnapshot,
  type MyWorkSnapshot,
} from '@/lib/pwa/pwaStore';

type MyWorkQuery = ReturnType<typeof useMyWork>;

/** The `useMyWork` fields the page reads, plus the offline-copy facts. */
export interface MyWorkWithSnapshot {
  data: MyWorkQuery['data'];
  isLoading: boolean;
  error: MyWorkQuery['error'];
  fetchNextPage: MyWorkQuery['fetchNextPage'];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  refetch: MyWorkQuery['refetch'];
  /** When the page is rendering the saved copy: the time it was saved. */
  snapshotSavedAt: number | null;
  /** Offline with nothing saved on this device yet. */
  offlineWithoutSnapshot: boolean;
}

/**
 * `useMyWork`, plus the offline fallback: saves each successful load and, when
 * the network is unreachable and there is no live data, serves the saved copy.
 */
export function useMyWorkWithOfflineSnapshot(): MyWorkWithSnapshot {
  const query = useMyWork();
  const online = useOnlineStatus();
  const { user } = useCurrentUser();
  const userId = user ? String(user.id) : null;
  const [snapshot, setSnapshot] = useState<MyWorkSnapshot | null>(null);
  const [checked, setChecked] = useState(false);

  // Save every live load for the signed-in user.
  useEffect(() => {
    if (query.data && userId) void saveMyWorkSnapshot(userId, query.data);
  }, [query.data, userId]);

  // A different signed-in user must never see the previous user's copy.
  useEffect(() => {
    if (userId && snapshot && !isSameUser(snapshot.userId, userId)) {
      setSnapshot(null);
      void purgePwaUserData();
    }
  }, [userId, snapshot]);

  const unreachable = !query.data && (!online || isNetworkFailure(query.error));

  useEffect(() => {
    if (!unreachable || checked) return;
    let cancelled = false;
    void loadMyWorkSnapshot().then((snap) => {
      if (cancelled) return;
      setSnapshot(snap);
      setChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [unreachable, checked]);

  const base = {
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    refetch: query.refetch,
  };
  if (unreachable && snapshot) {
    const saved: InfiniteData<MyWorkPage> = snapshot.data;
    return {
      ...base,
      data: saved,
      error: null,
      isLoading: false,
      snapshotSavedAt: snapshot.savedAt,
      offlineWithoutSnapshot: false,
    };
  }
  return {
    ...base,
    data: query.data,
    error: query.error,
    isLoading: query.isLoading,
    snapshotSavedAt: null,
    offlineWithoutSnapshot: unreachable && checked && !snapshot,
  };
}
