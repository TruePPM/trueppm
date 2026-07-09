import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { CurrentUser } from './useCurrentUser';

interface NotificationSettingsResponse {
  dnd_enabled: boolean;
}

interface DndMutationContext {
  previous?: CurrentUser;
}

/**
 * The single source for the two DND status-region strings, so the settings card
 * and the bell's panel quick-toggle can never word the announcement differently.
 */
export function dndAnnouncement(on: boolean): string {
  return on ? 'Do Not Disturb on — emails and push paused' : 'Do Not Disturb off';
}

/** Announced on an optimistic-write failure (the switch reverts alongside it). */
export const DND_ERROR_ANNOUNCEMENT = "Couldn't update Do Not Disturb. Try again.";

/**
 * PATCH /api/v1/me/notification-settings/ — set the caller's account-wide
 * Do-Not-Disturb switch (#1707, ADR-0292).
 *
 * Optimistic on the `['current-user']` query so the bell's muted glyph and both
 * toggle surfaces flip instantly; `onError` rolls the cached value back (callers
 * announce {@link DND_ERROR_ANNOUNCEMENT} on failure), and `onSettled`
 * reconciles with the server. `dnd_enabled` is read back from `/auth/me/`
 * (useCurrentUser), so writing the same cache key keeps the read authoritative.
 */
export function useUpdateNotificationSettings(): UseMutationResult<
  NotificationSettingsResponse,
  Error,
  boolean,
  DndMutationContext
> {
  const queryClient = useQueryClient();
  return useMutation<NotificationSettingsResponse, Error, boolean, DndMutationContext>({
    mutationFn: async (dndEnabled: boolean) => {
      const res = await apiClient.patch<NotificationSettingsResponse>(
        '/me/notification-settings/',
        { dnd_enabled: dndEnabled },
      );
      return res.data;
    },
    onMutate: async (dndEnabled) => {
      await queryClient.cancelQueries({ queryKey: ['current-user'] });
      const previous = queryClient.getQueryData<CurrentUser>(['current-user']);
      if (previous) {
        queryClient.setQueryData<CurrentUser>(['current-user'], {
          ...previous,
          dnd_enabled: dndEnabled,
        });
      }
      return { previous };
    },
    onError: (_err, _dndEnabled, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['current-user'], context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['current-user'] });
    },
  });
}
