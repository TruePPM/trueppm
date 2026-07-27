import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * The weekly slot at which scheduled digests are sent (ADR-0663, #2407).
 *
 * `weekday` is 0=Monday..6=Sunday, matching Python's `date.weekday()` — NOT
 * JavaScript's `Date.getDay()`, which is 0=Sunday. The server owns the semantics;
 * the picker below maps labels onto these values rather than converting, so there
 * is exactly one weekday convention on the wire.
 */
export interface DigestSchedule {
  digest_weekday: number;
  digest_hour: number;
  /** IANA key; empty string means "use the server timezone". */
  digest_timezone: string;
}

interface NotificationSettings extends DigestSchedule {
  dnd_enabled: boolean;
  updated_at: string;
}

export const DIGEST_SCHEDULE_KEY = ['notification-settings'] as const;

/** Monday-first labels, indexed by the server's 0=Monday convention. */
export const WEEKDAY_LABELS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** Render an hour (0-23) as a readable local time label. */
export function formatHour(hour: number): string {
  const suffix = hour < 12 ? 'am' : 'pm';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:00 ${suffix}`;
}

/**
 * Summary sentence for the digest schedule, shared by the settings card and its
 * status announcement so the two can never word the slot differently.
 */
export function describeSchedule(schedule: DigestSchedule): string {
  const day = WEEKDAY_LABELS[schedule.digest_weekday] ?? 'Sunday';
  const zone = schedule.digest_timezone || 'your server timezone';
  return `Digests send ${day}s at ${formatHour(schedule.digest_hour)} (${zone}).`;
}

/** GET /api/v1/me/notification-settings/ — the caller's own row. */
export function useDigestSchedule(): UseQueryResult<NotificationSettings, Error> {
  return useQuery<NotificationSettings, Error>({
    queryKey: DIGEST_SCHEDULE_KEY,
    queryFn: async () => {
      const res = await apiClient.get<NotificationSettings>('/me/notification-settings/');
      return res.data;
    },
  });
}

/**
 * PATCH the weekly digest slot.
 *
 * Optimistic on {@link DIGEST_SCHEDULE_KEY} so the picker and its summary line
 * move together; `onError` rolls back and `onSettled` reconciles. Deliberately
 * NOT written into `['current-user']` — unlike `dnd_enabled`, the slot is not
 * projected onto `/auth/me`, so this query is its own source of truth.
 */
export function useUpdateDigestSchedule(): UseMutationResult<
  NotificationSettings,
  Error,
  Partial<DigestSchedule>,
  { previous?: NotificationSettings }
> {
  const queryClient = useQueryClient();
  return useMutation<
    NotificationSettings,
    Error,
    Partial<DigestSchedule>,
    { previous?: NotificationSettings }
  >({
    mutationFn: async (patch) => {
      const res = await apiClient.patch<NotificationSettings>('/me/notification-settings/', patch);
      return res.data;
    },
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: DIGEST_SCHEDULE_KEY });
      const previous = queryClient.getQueryData<NotificationSettings>(DIGEST_SCHEDULE_KEY);
      if (previous) {
        queryClient.setQueryData<NotificationSettings>(DIGEST_SCHEDULE_KEY, {
          ...previous,
          ...patch,
        });
      }
      return { previous };
    },
    onError: (_err, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(DIGEST_SCHEDULE_KEY, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: DIGEST_SCHEDULE_KEY });
    },
  });
}
