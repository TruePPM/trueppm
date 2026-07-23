/**
 * Hook for GET /api/v1/health/system/ — workspace-admin system health overview.
 *
 * Polls every 10 s while the tab is visible (refetchIntervalInBackground:false).
 * retry:false keeps the error surface immediate — network hiccups surface to the
 * operator rather than silently retrying behind a spinner.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
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

/**
 * Per-signal live export-health verdict (ADR-0601, #2109). Computed server-side so
 * the card, the API, and any MCP/agent consumer agree on "is export healthy?".
 *
 * - `healthy`  — a success within the window (the "8 s ago · 1,204 spans" strip)
 * - `idle`     — traces only: enabled, no recent export, no error (quiet system)
 * - `failing`  — most recent outcome across live pods is an error
 * - `stalled`  — enabled, has succeeded before, but no success within the window
 * - `never`    — enabled, nothing exported yet (also the evicted-record fallback)
 * - `disabled` — this signal's export is switched off by config
 */
export type TelemetrySignalState = 'healthy' | 'idle' | 'failing' | 'stalled' | 'never' | 'disabled';

export interface TelemetrySignalHealth {
  state: TelemetrySignalState;
  last_success_at: string | null;
  /** Age computed server-side against `generated_at` — immune to browser clock skew. */
  last_success_age_seconds: number | null;
  items_per_window: number;
  last_error: string | null;
  last_error_at: string | null;
  pods_reporting: number;
}

/**
 * Live cluster export-health block. `available: false` means the metrics store was
 * unreachable or the recorder is disabled — the card then keeps the config posture
 * and hides the live strip rather than showing a fabricated number.
 */
export type SystemHealthTelemetryLive =
  | { available: false }
  | {
      available: true;
      window_seconds: number;
      pods_reporting: number;
      traces: TelemetrySignalHealth;
      metrics: TelemetrySignalHealth;
    };

/**
 * Read-only OpenTelemetry exporter posture (#2022). Env/Helm-configured only —
 * never writable from the app. Headers (the export bearer token) are never sent.
 * `enabled` is true only when an endpoint is set and the master switch is on.
 * `live` (ADR-0601, #2109) carries the cross-process live export-health strip.
 */
export interface SystemHealthTelemetry {
  enabled: boolean;
  endpoint: string;
  endpoint_configured: boolean;
  protocol: string;
  service_name: string;
  service_version: string;
  edition: string;
  traces_enabled: boolean;
  metrics_enabled: boolean;
  sampler: string;
  sampler_arg: string;
  live: SystemHealthTelemetryLive;
}

/**
 * Result of POST /health/telemetry/test/ (#2110). `mode` reflects whether a real
 * canary span was sent (`export`) or only a TCP reachability probe (`probe`, when
 * export is switched off). `detail` is a canned server sentence — never carries the
 * OTLP bearer token. `reachable` means the collector answered but no span was sent.
 */
export type TelemetryTestMode = 'export' | 'probe';
export type TelemetryTestOutcome = 'success' | 'reachable' | 'failure';

export interface TelemetryTestResult {
  mode: TelemetryTestMode;
  outcome: TelemetryTestOutcome;
  endpoint: string;
  protocol: string;
  duration_ms: number;
  detail: string;
  checked_at: string;
}

export interface SystemHealthResponse {
  generated_at: string;
  components: SystemHealthComponent[];
  beat: SystemHealthBeat;
  scheduled_tasks: ScheduledTask[];
  dead_letter: SystemHealthDeadLetter;
  retention: RetentionEntry[];
  telemetry: SystemHealthTelemetry;
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
 *
 * `poll` (default `true`) drives the 10 s foreground refresh that makes the
 * System Health *console* a live dashboard. The consolidated `/settings` page
 * consumes the SAME query with `poll: false` for its System-health landing card
 * and the inline Observability section — a single cheap fetch, no background
 * poll wedged into a form-editing page (#2298; the live console keeps its poll
 * on its own route). The status line stamps freshness from `generated_at`.
 */
export function useSystemHealth({ poll = true }: { poll?: boolean } = {}) {
  return useQuery<SystemHealthResponse, Error>({
    queryKey: systemHealthKeys.detail(),
    queryFn: async () => {
      const res = await apiClient.get<SystemHealthResponse>('/health/system/');
      return res.data;
    },
    refetchInterval: poll ? 10_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/**
 * Triggers the admin-only OTLP export probe (POST /health/telemetry/test/).
 *
 * Sends no body — the target is read only from server settings. The endpoint
 * always responds 200 with the probe outcome in the body, so a collector that is
 * down surfaces as `outcome: "failure"`, not a thrown error. Not invalidating any
 * query: this is a one-off diagnostic, it changes no server state.
 */
export function useTelemetryTestExport() {
  return useMutation<TelemetryTestResult, Error, void>({
    mutationFn: async () => {
      const res = await apiClient.post<TelemetryTestResult>('/health/telemetry/test/');
      return res.data;
    },
  });
}
