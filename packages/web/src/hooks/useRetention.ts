/**
 * Hooks for the retention policy editor + purge runs (ADR-0173).
 *
 * GET  /api/v1/health/retention/         — policy table, schedule, recent runs
 * PATCH /api/v1/health/retention/        — save-bar commit
 * GET  /api/v1/health/retention/impact/  — lower-value irreversibility estimate
 * POST /api/v1/health/retention/runs/    — run-now / dry-run (202, async)
 *
 * Response shapes are hand-declared (snake_case, straight from the API) — do NOT
 * edit src/api/types.ts. Matches the useSystemHealth convention for these
 * workspace-admin health endpoints.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { systemHealthKeys } from '@/hooks/useSystemHealth';

// ---------------------------------------------------------------------------
// API response shapes (hand-declared; do NOT edit src/api/types.ts).
// ---------------------------------------------------------------------------

export type RetentionUnit = 'days' | 'hours';

export interface RetentionPolicyRow {
  key: string;
  label: string;
  note: string;
  unit: RetentionUnit;
  value: number;
  enabled: boolean;
  /** PostgreSQL estimate — approximate. */
  row_count: number;
  /** PostgreSQL estimate — approximate; null when stats are unavailable. */
  bytes: number | null;
}

export type ScheduleFrequency = 'daily' | 'weekly' | 'off';
export type ScheduleOnFailure = 'continue' | 'stop';

export interface RetentionSchedule {
  frequency: ScheduleFrequency;
  /** "HH:MM:SS", interpreted as UTC with no DST shift. */
  time_of_day_utc: string;
  /** 0 (Monday) – 6 (Sunday); only meaningful when frequency is weekly. */
  day_of_week: number | null;
  on_failure: ScheduleOnFailure;
}

export type PurgeRunTrigger = 'scheduled' | 'manual' | 'dry_run';
export type PurgeRunState = 'running' | 'ok' | 'partial' | 'failed';

export interface PurgeRunTableResult {
  key: string;
  label: string;
  rows: number;
  bytes: number | null;
  state: string;
  error: string;
}

export interface PurgeRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: PurgeRunTrigger;
  state: PurgeRunState;
  tables: PurgeRunTableResult[];
  rows_deleted: number;
  bytes_freed: number | null;
  error: string;
  duration_ms: number | null;
}

export interface RetentionState {
  policies: RetentionPolicyRow[];
  schedule: RetentionSchedule;
  runs: PurgeRun[];
}

export interface RetentionImpact {
  eligible_rows: number;
  eligible_bytes: number | null;
}

export interface RetentionPolicyUpdate {
  key: string;
  value: number;
  enabled: boolean;
}

export interface RetentionUpdatePayload {
  policies?: RetentionPolicyUpdate[];
  schedule?: RetentionSchedule;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const retentionKeys = {
  all: ['retention'] as const,
  state: () => [...retentionKeys.all, 'state'] as const,
  impact: (key: string, value: number) => [...retentionKeys.all, 'impact', key, value] as const,
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Read the retention policy, schedule, and recent purge runs.
 *
 * Auto-refreshes every 3 s **only** while a run is in-flight, so a just-queued
 * purge flips from "running" to its terminal state in the log without operator
 * action — then polling stops.
 */
export function useRetentionSettings() {
  return useQuery({
    queryKey: retentionKeys.state(),
    queryFn: async () => (await apiClient.get<RetentionState>('/health/retention/')).data,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.runs.some((run) => run.state === 'running') ? 3000 : false;
    },
  });
}

/** Save retention overrides and/or schedule; returns (and caches) the fresh state. */
export function useUpdateRetention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: RetentionUpdatePayload) =>
      (await apiClient.patch<RetentionState>('/health/retention/', payload)).data,
    onSuccess: (data) => {
      queryClient.setQueryData(retentionKeys.state(), data);
      // The overview's Retention card reflects the same windows.
      void queryClient.invalidateQueries({ queryKey: systemHealthKeys.detail() });
    },
  });
}

/**
 * Estimate rows/bytes that would become purge-eligible at a proposed window.
 * `value` is in the table's native unit (days, or hours for sync batches).
 * Only runs when `enabled` (i.e. the operator has lowered the value).
 */
export function useRetentionImpact(key: string, value: number, enabled: boolean) {
  return useQuery({
    queryKey: retentionKeys.impact(key, value),
    queryFn: async () =>
      (await apiClient.get<RetentionImpact>('/health/retention/impact/', { params: { key, value } }))
        .data,
    enabled,
    staleTime: 30_000,
  });
}

/** Queue a manual purge (or dry-run). Returns 202 {queued, run_id}; refreshes the log. */
export function useRunPurge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (dryRun: boolean) =>
      (
        await apiClient.post<{ queued: boolean; run_id: string }>('/health/retention/runs/', {
          dry_run: dryRun,
        })
      ).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: retentionKeys.state() });
    },
  });
}
