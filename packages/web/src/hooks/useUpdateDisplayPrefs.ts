import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { DateFormatStyle } from '@/lib/dateFormatStyle';

/**
 * PATCH /api/v1/auth/me/profile/ — set the caller's display frame (#1953,
 * ADR-0410). Two single-field hooks mirroring `useUpdateRoleContext`: on success
 * the `['current-user']` query is invalidated so every date/timestamp surface
 * re-reads the new preference (and `AppShell` re-syncs the module date-format
 * default for the unconverted long tail).
 *
 * Validation is server-side (400 on an unknown IANA zone or an out-of-range
 * style); callers surface the error inline and revert the optimistic control.
 */

interface TimezoneResponse {
  timezone: string;
}

interface DateFormatResponse {
  date_format: DateFormatStyle;
}

export function useUpdateTimezone(): UseMutationResult<TimezoneResponse, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (value: string) => {
      const res = await apiClient.patch<TimezoneResponse>('/auth/me/profile/', {
        timezone: value,
      });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['current-user'] });
    },
  });
}

export function useUpdateDateFormat(): UseMutationResult<DateFormatResponse, Error, DateFormatStyle> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (value: DateFormatStyle) => {
      const res = await apiClient.patch<DateFormatResponse>('/auth/me/profile/', {
        date_format: value,
      });
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['current-user'] });
    },
  });
}
