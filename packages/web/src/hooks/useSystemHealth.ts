/**
 * Hook for GET /api/v1/health/system/ — workspace-admin system health overview.
 *
 * Polls every 10 s while the tab is visible (refetchIntervalInBackground:false).
 * retry:false keeps the error surface immediate — network hiccups surface to the
 * operator rather than silently retrying behind a spinner.
 */

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

// ---------------------------------------------------------------------------
// API response shapes (hand-declared; do NOT edit src/api/types.ts).
// ---------------------------------------------------------------------------

export type ComponentStatus = 'ok' | 'warn' | 'crit' | 'unknown';

export interface SystemHealthComponent {
  key: string;
  label: string;
  status: ComponentStatus;
  state_label: string;
  meta: string;
}

export interface SystemHealthBeat {
  last_heartbeat: string | null;
  seconds_since: number | null;
  stale: boolean;
  stale_threshold_seconds: number;
}

export type ScheduledTaskCategory = 'heartbeat' | 'drain' | 'purge' | 'snapshot' | 'other';

export interface ScheduledTask {
  name: string;
  task: string;
  cadence: string;
  category: ScheduledTaskCategory;
}

export interface SystemHealthDeadLetter {
  parked: number;
  oldest_age_seconds: number | null;
  top_cause: string | null;
  by_status: Record<string, number>;
}

export interface RetentionEntry {
  key: string;
  label: string;
  unit: 'days' | 'hours';
  value: number | null;
  disabled: boolean;
}

export interface SystemHealthResponse {
  generated_at: string;
  components: SystemHealthComponent[];
  beat: SystemHealthBeat;
  scheduled_tasks: ScheduledTask[];
  dead_letter: SystemHealthDeadLetter;
  retention: RetentionEntry[];
}

// ---------------------------------------------------------------------------
// Query key factory
// ---------------------------------------------------------------------------

export const systemHealthKeys = {
  all: ['system-health'] as const,
  detail: () => [...systemHealthKeys.all, 'detail'] as const,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Fetches the workspace system-health overview.
 *
 * Requires admin-level access; the component renders a 403-specific message
 * when the server returns 403 (checked by inspecting `error.response?.status`).
 * Polls every 10 s while the tab is in the foreground so operators can leave
 * this page open as a lightweight status dashboard.
 */
export function useSystemHealth() {
  return useQuery<SystemHealthResponse, Error>({
    queryKey: systemHealthKeys.detail(),
    queryFn: async () => {
      const res = await apiClient.get<SystemHealthResponse>('/health/system/');
      return res.data;
    },
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
