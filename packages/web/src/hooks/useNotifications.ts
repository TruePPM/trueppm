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
import type { PaginatedResponse } from '@/api/types';
import type {
  NotificationCategory,
  NotificationFilter,
} from '@/features/shell/notificationFilters';
import type { NotificationPreferenceRow } from './useNotificationPreferences';

const POLL_INTERVAL_MS = 30_000;
const UNREAD_KEY = ['me-notifications-unread-count'];
const NOTIFICATIONS_KEY = ['me-notifications'];
// Shared with useNotificationPreferences — the mute helper writes an in-app
// preference row, so it invalidates the same cache the preferences page reads.
const PREFS_KEY = ['me-notification-preferences'];

/** Snooze preset keys accepted by POST /me/notifications/{id}/snooze/. */
export type NotificationSnoozePreset = '1h' | '3h' | 'tomorrow';

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
  /** ISO datetime a snoozed row reappears at, or null when not snoozed (ADR-0213 §1). */
  snoozed_until: string | null;
  /** Derived server-side: mentions | tasks | signals | project (ADR-0213 §3). */
  category: string;
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
 *
 * Snoozed rows are excluded server-side (the list endpoint's unread path
 * applies the `snoozed_until > now()` exclusion, ADR-0213 §1) so a deferred
 * notification never lights the badge — no client-side filtering needed here.
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
  filter: NotificationFilter;
  /** Orthogonal category filter; defaults to 'all' (no `?category=` param). */
  category?: NotificationCategory;
}

/**
 * GET /me/notifications/ — filter-scoped inbox list.
 *
 * Page-number pagination accumulated via `useInfiniteQuery` so the slide-out
 * fetches one PAGE_SIZE (50) page at a time and the panel offers "Load more",
 * rather than mapping an unbounded result set into a 420px column (issue 1556).
 * Mirrors the `useDecisions` / `useMyWork` infinite-query pattern.
 *
 * The read-state (filter) AND category dimensions are both part of the query
 * key so switching either re-fetches instead of colliding on one cache slot
 * (ADR-0213 §4).
 */
export function useNotifications({ filter, category = 'all' }: UseNotificationsOptions) {
  const query = useInfiniteQuery<
    ListResult,
    Error,
    { pages: ListResult[] },
    string[],
    number
  >({
    queryKey: [...NOTIFICATIONS_KEY, filter, category],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const params: Record<string, string | number> = { page: pageParam };
      if (filter === 'unread') params.unread_only = 'true';
      if (filter === 'archived') params.archived = 'true';
      if (filter === 'snoozed') params.snoozed = 'true';
      if (category !== 'all') params.category = category;
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

interface SnoozeVars {
  id: string;
  /** A preset key (server resolves the exact time) … */
  preset?: NotificationSnoozePreset;
  /** … or an explicit ISO datetime, or `null` to un-snooze. */
  until?: string | null;
}

/**
 * POST /me/notifications/{id}/snooze/ — defer (or un-snooze) a single row.
 *
 * Send `{ preset }` for a 1h/3h/tomorrow preset, or `{ until }` with an ISO
 * datetime (or `null` to un-snooze). A snoozed row drops out of the All/Unread
 * views and the bell count until its time passes, so both the list and the
 * unread-count caches are invalidated (ADR-0213 §1).
 */
export function useSnoozeNotification() {
  const queryClient = useQueryClient();
  return useMutation<NotificationRow, Error, SnoozeVars>({
    mutationFn: async ({ id, preset, until }) => {
      const body: { preset?: NotificationSnoozePreset; until?: string | null } = {};
      if (preset !== undefined) body.preset = preset;
      if (until !== undefined) body.until = until;
      const res = await apiClient.post<NotificationRow>(
        `/me/notifications/${id}/snooze/`,
        body,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: UNREAD_KEY });
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });
}

interface MuteVars {
  /** The row's event_type — resolved to the user's in-app preference row. */
  eventType: string;
  /** true = mute (in-app off, default); false = un-mute (the Undo path). */
  mute?: boolean;
}

/**
 * Mute (or un-mute) a notification *type* from the inbox (ADR-0213 §2).
 *
 * Reuses the existing per-`(event_type, channel)` preference plumbing rather
 * than adding a new model: it resolves the user's IN-APP preference row for the
 * given event type and toggles it off, turning off *future* in-app delivery of
 * that type. Email is untouched — muting from the inbox never silences email,
 * whose control stays in settings (hence the "muted in your inbox" copy).
 *
 * Two requests (resolve the preference id, then PATCH it) because the row's
 * event_type is all the caller has; the preference id lives on a different
 * endpoint. Invalidates the preferences cache (so the settings page reflects
 * it) plus the inbox + bell caches.
 */
export function useMuteNotificationType() {
  const queryClient = useQueryClient();
  return useMutation<NotificationPreferenceRow, Error, MuteVars>({
    mutationFn: async ({ eventType, mute = true }) => {
      const list = await apiClient.get<PaginatedResponse<NotificationPreferenceRow>>(
        '/me/notification-preferences/',
      );
      const pref = list.data.results.find(
        (p) => p.event_type === eventType && p.channel === 'in_app',
      );
      if (!pref) {
        throw new Error(`No in-app notification preference for "${eventType}".`);
      }
      const res = await apiClient.patch<NotificationPreferenceRow>(
        `/me/notification-preferences/${pref.id}/`,
        { enabled: !mute },
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PREFS_KEY });
      void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: UNREAD_KEY });
    },
  });
}
