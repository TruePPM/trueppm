/**
 * Hook for the per-user (event_type, channel) notification toggle matrix
 * (ADR-0075 §A.7, #311 frontend phase 4).
 *
 * The list endpoint backfills DEFAULT_PREFERENCES on first GET per user
 * (server-side, see notifications/views.py NotificationPreferenceViewSet.list)
 * — Priya's "email OFF for both events" flip lands automatically.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse } from '@/api/types';

const PREFS_KEY = ['me-notification-preferences'];

export interface NotificationPreferenceRow {
  id: number;
  event_type: string;
  channel: string;
  enabled: boolean;
  updated_at: string;
}

/** GET /api/v1/me/notification-preferences/ */
export function useNotificationPreferences() {
  const query = useQuery({
    queryKey: PREFS_KEY,
    queryFn: async () => {
      // The list endpoint is paginated (DRF PageNumberPagination, PAGE_SIZE=50)
      // so the body is the {count,next,previous,results} envelope, not a bare
      // array — unwrap results. The matrix is four rows today, well under one
      // page. (#792)
      const res = await apiClient.get<PaginatedResponse<NotificationPreferenceRow>>(
        '/me/notification-preferences/',
      );
      return res.data.results;
    },
  });

  return {
    preferences: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

interface UpdateVars {
  id: number;
  enabled: boolean;
}

/**
 * PATCH /api/v1/me/notification-preferences/{id}/
 *
 * Optimistic update with rollback so toggle clicks feel instant. The cache
 * key is shared with useNotificationPreferences so the toggle UI re-renders
 * from the updated cache without re-fetching.
 */
export function useUpdateNotificationPreference() {
  const queryClient = useQueryClient();
  return useMutation<
    NotificationPreferenceRow,
    Error,
    UpdateVars,
    { previous: NotificationPreferenceRow[] | undefined }
  >({
    mutationFn: async ({ id, enabled }) => {
      const res = await apiClient.patch<NotificationPreferenceRow>(
        `/me/notification-preferences/${id}/`,
        { enabled },
      );
      return res.data;
    },
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: PREFS_KEY });
      const previous = queryClient.getQueryData<NotificationPreferenceRow[]>(PREFS_KEY);
      queryClient.setQueryData<NotificationPreferenceRow[]>(
        PREFS_KEY,
        (current) => current?.map((p) => (p.id === id ? { ...p, enabled } : p)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(PREFS_KEY, context.previous);
      }
    },
    // Settle re-fetches the source of truth — keeps the cache eventually
    // consistent if the server side adds new event_type/channel rows
    // (e.g. Enterprise channels via ADR-0049 registry).
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PREFS_KEY });
    },
  });
}

/** Notification preset keys (#855, ADR-0118). */
export type NotificationPreset = 'signal_only' | 'everything';

/**
 * POST /api/v1/me/notification-preferences/apply-preset/
 *
 * Wholesale-applies a preset and seeds the cache with the returned matrix.
 * `signal_only` is Priya's one-click escape from a noisy default (in-app ON for
 * blocked + deadline-changed only); `everything` restores the recommended
 * defaults. The server returns the full refreshed row list, so we write it
 * straight into the shared cache instead of re-fetching.
 */
export function useApplyNotificationPreset() {
  const queryClient = useQueryClient();
  return useMutation<NotificationPreferenceRow[], Error, NotificationPreset>({
    mutationFn: async (preset) => {
      const res = await apiClient.post<NotificationPreferenceRow[]>(
        '/me/notification-preferences/apply-preset/',
        { preset },
      );
      return res.data;
    },
    onSuccess: (rows) => {
      queryClient.setQueryData<NotificationPreferenceRow[]>(PREFS_KEY, rows);
    },
  });
}
