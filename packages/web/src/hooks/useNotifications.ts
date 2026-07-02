/**
 * Hooks for the per-user notification inbox (ADR-0075 §A.6, #311 frontend phase 3).
 *
 * The unread-count poll runs every 30 s (per ADR §F real-time strategy) and
 * pauses when the browser tab is hidden via the Page Visibility API — so a
 * minimized tab doesn't burn battery or hit the API for nothing.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiClient } from '@/api/client';

const POLL_INTERVAL_MS = 30_000;
const UNREAD_KEY = ['me-notifications-unread-count'];
const NOTIFICATIONS_KEY = ['me-notifications'];

export interface NotificationMentionAuthor {
  id: string;
  username: string;
  display_name: string;
}

export interface NotificationMention {
  id: string;
  mentioner: NotificationMentionAuthor | null;
  mentioned_user: NotificationMentionAuthor | null;
  mentioned_group_key: string;
  scope: string;
  task_comment: string | null;
  created_at: string;
}

export interface NotificationRow {
  id: string;
  recipient: string;
  mention: NotificationMention | null;
  /**
   * Event-sourced payload (#639/#497/#861). Empty `event_type` means a
   * mention-sourced row (render from `mention` + `snippet`); a non-empty
   * `event_type` means an event row whose title is `subject` and preview is
   * `body`.
   */
  event_type: string;
  subject: string;
  body: string;
  project: string;
  is_read: boolean;
  is_archived: boolean;
  created_at: string;
  read_at: string | null;
  snippet: string;
  task_id: string | null;
}

interface ListResult {
  count: number;
  next: string | null;
  previous: string | null;
  results: NotificationRow[];
}

/**
 * Returns whether the current tab is visible. Used to pause the unread poll
 * when the user has the tab minimized — a small battery+API win that adds
 * up over the day.
 */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    typeof document !== 'undefined' ? !document.hidden : true,
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    function onVis() {
      setVisible(!document.hidden);
    }
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  return visible;
}

/**
 * Polls /me/notifications/?unread_only=true&limit=0 every 30 s and returns
 * the unread count. Pauses when the tab is hidden. Used by NotificationBell
 * to drive the badge.
 */
export function useUnreadNotificationCount(): { count: number; isLoading: boolean } {
  const visible = useDocumentVisible();
  const query = useQuery({
    queryKey: UNREAD_KEY,
    queryFn: async () => {
      const res = await apiClient.get<ListResult>('/me/notifications/', {
        params: { unread_only: 'true', limit: 0 },
      });
      return res.data.count ?? 0;
    },
    refetchInterval: visible ? POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
  });

  return { count: query.data ?? 0, isLoading: query.isLoading };
}

interface UseNotificationsOptions {
  filter: 'all' | 'unread' | 'archived';
}

/**
 * GET /me/notifications/ — filter-scoped inbox list.
 *
 * Page-number pagination accumulated via `useInfiniteQuery` so the slide-out
 * fetches one PAGE_SIZE (50) page at a time and the panel offers "Load more",
 * rather than mapping an unbounded result set into a 420px column (issue 1556).
 * Mirrors the `useDecisions` / `useMyWork` infinite-query pattern.
 */
export function useNotifications({ filter }: UseNotificationsOptions) {
  const query = useInfiniteQuery<
    ListResult,
    Error,
    { pages: ListResult[] },
    string[],
    number
  >({
    queryKey: [...NOTIFICATIONS_KEY, filter],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string | number> = { page: pageParam };
      if (filter === 'unread') params.unread_only = 'true';
      if (filter === 'archived') params.archived = 'true';
      const res = await apiClient.get<ListResult>('/me/notifications/', { params });
      return res.data;
    },
    // DRF returns a full `next` URL; presence means there is another page.
    getNextPageParam: (lastPage, allPages) => (lastPage.next ? allPages.length + 1 : undefined),
  });

  return {
    notifications: query.data?.pages.flatMap((p) => p.results) ?? [],
    isLoading: query.isLoading,
    error: query.error,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

interface UpdateVars {
  id: string;
  is_read?: boolean;
  is_archived?: boolean;
}

/** PATCH /me/notifications/{id}/ — toggle read or archive state. */
export function useUpdateNotification() {
  const queryClient = useQueryClient();
  return useMutation<NotificationRow, Error, UpdateVars>({
    mutationFn: async ({ id, ...patch }) => {
      const res = await apiClient.patch<NotificationRow>(`/me/notifications/${id}/`, patch);
      return res.data;
    },
    onSuccess: () => {
      // Surface the new read / archive state on the bell badge + every open list
      void queryClient.invalidateQueries({ queryKey: UNREAD_KEY });
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });
}

/** POST /me/notifications/mark-all-read/ — bulk transition. */
export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation<{ updated: number }, Error, void>({
    mutationFn: async () => {
      const res = await apiClient.post<{ updated: number }>(
        '/me/notifications/mark-all-read/',
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: UNREAD_KEY });
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });
}
