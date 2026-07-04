import { MutationCache, QueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useSyncStatusStore } from '@/stores/syncStatusStore';

export const queryClient = new QueryClient({
  // Every successful write stamps the session "last synced" time that powers the
  // SyncStatusBadge (ADR-0201). Reading the store lazily via getState() keeps this
  // module free of React and avoids a hook dependency at client-construction time.
  mutationCache: new MutationCache({
    onSuccess: () => {
      useSyncStatusStore.getState().markSynced();
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
