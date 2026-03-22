import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 1-minute stale time: P3M data changes infrequently, avoid aggressive refetches
      staleTime: 1000 * 60,
      retry: 1,
      // Disable focus refetch: users switch windows often when working with Gantt charts
      refetchOnWindowFocus: false,
    },
  },
});
