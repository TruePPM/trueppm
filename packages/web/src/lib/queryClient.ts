import { MutationCache, QueryClient } from '@tanstack/react-query';
import { purgePwaUserData } from '@/lib/pwa/pwaStore';
import axios from 'axios';
import { useSyncStatusStore } from '@/stores/syncStatusStore';
import { registerSessionBridge, useAuthStore } from '@/stores/authStore';
import { toast } from '@/components/Toast/toast';

export const queryClient = new QueryClient({
  // Every successful write stamps the session "last synced" time that powers the
  // SyncStatusBadge (ADR-0205). Reading the store lazily via getState() keeps this
  // module free of React and avoids a hook dependency at client-construction time.
  mutationCache: new MutationCache({
    onSuccess: () => {
      useSyncStatusStore.getState().markSynced();
    },
    // A mutation attempted while the user is in the read-only escape hatch
    // (#1922) is always doomed: the apiClient request interceptor rejects it
    // synchronously before anything reaches the network, since `sessionExpired`
    // is still true underneath. The first one gets a light toast (#4316) so a
    // misclick on an editable cell does not throw a full-viewport modal over the
    // screen; a repeat re-engages the blocking re-auth modal so the user is not
    // left retrying the same control in a silent loop. No-ops once the modal is
    // already showing or the session is fine.
    onError: () => {
      if (useAuthStore.getState().reassertSessionExpired() === 'cue') {
        toast.info("That change wasn't saved. Sign in again to make changes.");
      }
    },
  }),
  defaultOptions: {
    queries: {
      // 1-minute stale time: P3M data changes infrequently, avoid aggressive refetches
      staleTime: 1000 * 60,
      // Never retry 401s — the Axios interceptor handles token refresh and retries
      // at the HTTP level. A 401 that reaches TanStack Query means the session is
      // expired; retrying races with the login flow and can wipe freshly-set tokens.
      retry: (failureCount, error) => {
        if (axios.isAxiosError(error) && error.response?.status === 401) return false;
        return failureCount < 1;
      },
      // Disable focus refetch: users switch windows often when working with Gantt charts
      refetchOnWindowFocus: false,
    },
  },
});

// What the auth store needs to know about the data layer when a session ends. The
// store cannot import this module (it imports the store), so it is registered here.
// Reads that succeed before anyone has signed in (the edition/demo flags drive the
// login page itself), so a success here says nothing about content a user could keep
// viewing. Counting them made every cold load look warm and skipped the modal.
const PUBLIC_QUERY_ROOTS = new Set(['edition']);

/**
 * Drop everything held for the current user: every cached read AND the installed
 * app's on-device copy (ADR-1523 §4). Called wherever a session ends or is replaced
 * by a possibly different user's (sign-in, SSO completion, a sibling tab's sign-in
 * as someone else), so the purge cannot be skipped by a path that only cleared the
 * cache. On a fresh sign-in it runs before the new user's first `/me/work/` read can
 * land, so it never deletes that user's own snapshot; the purge never throws, so a
 * failing IndexedDB cannot block the sign-in.
 */
export function clearUserData(): void {
  queryClient.clear();
  void purgePwaUserData();
}

registerSessionBridge({
  inspect: () => ({
    // `pending` covers paused mutations too (offline-queued writes sit pending).
    interrupted: queryClient
      .getMutationCache()
      .getAll()
      .some((m) => m.state.status === 'pending'),
    // Something has loaded, so "Continue viewing" has content to show. A cold load
    // that dies in RequireAuth's bootstrap has an empty cache, which is the case
    // #4313 withdraws the escape hatch for. (Coarser than "the current route's
    // queries": a shell read that succeeded counts, because observer state was too
    // unstable a signal to key a security-adjacent surface on.)
    hasContent: queryClient
      .getQueryCache()
      .getAll()
      .some(
        (q) =>
          q.state.status === 'success' &&
          q.state.data !== undefined &&
          !PUBLIC_QUERY_ROOTS.has(String(q.queryKey[0])),
      ),
  }),
  clearCache: clearUserData,
});
