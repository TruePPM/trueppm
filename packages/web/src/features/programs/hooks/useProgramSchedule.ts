import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { apiClient } from '@/api/client';

/**
 * Client types for `GET /api/v1/programs/{id}/schedule/` (ADR-0120 §D3 read
 * side, consumed by the issue 1118 program schedule view per ADR-0182).
 *
 * The endpoint is serialized inline (no named OpenAPI component), so these
 * types are hand-written to mirror the verified server contract. They are the
 * render-don't-derive source (ADR-0115): the browser never recomputes the
 * cross-project CPM — it draws what the server returns.
 */

/** One project lane in the merged program schedule. */
export interface ProgramScheduleLane {
  id: string;
  name: string;
  /** Whether the requester may read this member project's tasks in full. */
  accessible: boolean;
}

/** A task the requester can read in full. Discriminated by `is_external: false`. */
export interface ProgramScheduleFullTask {
  id: string;
  name: string;
  hex_id: string;
  project_id: string;
  is_milestone: boolean;
  is_external: false;
  wbs_path: string | null;
  early_start: string | null;
  early_finish: string | null;
  late_start: string | null;
  late_finish: string | null;
  total_float_days: number | null;
  is_critical: boolean;
}

/**
 * A task in a member project the requester cannot access, redacted to the
 * ADR-0120 D5 ExternalTaskCard shape. Discriminated by `is_external: true`.
 * Note the text key is `title` (not `name`) — that is the D5 contract.
 */
export interface ProgramScheduleExternalTask {
  id: string;
  title: string;
  hex_id: string;
  project_id: string;
  project_name: string;
  is_milestone: boolean;
  is_external: true;
  early_start: string | null;
  early_finish: string | null;
  is_critical: boolean;
}

export type ProgramScheduleTask = ProgramScheduleFullTask | ProgramScheduleExternalTask;

/** A leaf-level dependency edge in the merged graph. */
export interface ProgramScheduleLink {
  predecessor_id: string;
  successor_id: string;
  dep_type: 'FS' | 'SS' | 'FF' | 'SF';
  lag_days: number;
  /** True when the edge connects two different member projects. */
  is_cross_project: boolean;
}

/** The full `GET /programs/{id}/schedule/` response. */
export interface ProgramSchedule {
  program_id: string;
  start_date: string | null;
  finish_date: string | null;
  projects: ProgramScheduleLane[];
  tasks: ProgramScheduleTask[];
  links: ProgramScheduleLink[];
  critical_path: string[];
  cross_project_edge_count: number;
}

/**
 * Classification of a failed program-schedule fetch, so the page can render the
 * right state without re-parsing the axios error in the component.
 *
 * - `too-large` (422): exceeds `MAX_PROGRAM_TASKS` — render the informational
 *   too-large panel (an expected limit, not a failure).
 * - `forbidden` (403): the requester is not a program member.
 * - `not-computed` (409): handled defensively only. The endpoint does NOT emit a
 *   409 — when nothing is scheduled yet it returns `200` with an empty payload,
 *   which the page renders as the empty state from `tasks.length === 0`. This
 *   mapping exists so that if a 409 is ever introduced it degrades to the empty
 *   state rather than a hard error.
 * - `unknown`: network / 5xx — render a retryable inline error.
 */
export type ProgramScheduleErrorKind = 'not-computed' | 'too-large' | 'forbidden' | 'unknown';

/** Map a TanStack Query error from {@link useProgramSchedule} to its kind. */
export function classifyProgramScheduleError(error: unknown): ProgramScheduleErrorKind {
  if (isAxiosError(error)) {
    switch (error.response?.status) {
      case 409:
        return 'not-computed';
      case 422:
        return 'too-large';
      case 403:
        return 'forbidden';
      default:
        return 'unknown';
    }
  }
  return 'unknown';
}

/**
 * GET /api/v1/programs/{id}/schedule/ — the merged, program-true cross-project
 * schedule (ADR-0120 D3 read side). Compute-on-read, so live updates invalidate
 * this query whenever any member project's CPM changes (see the page's
 * per-project WebSocket subscribers).
 *
 * 409/422/403 are surfaced via {@link classifyProgramScheduleError}; the query
 * does not retry on those (they are stable states, not transient failures).
 */
export function useProgramSchedule(
  programId: string | undefined,
): UseQueryResult<ProgramSchedule> {
  return useQuery({
    queryKey: ['programs', programId, 'schedule'],
    queryFn: async () => {
      const res = await apiClient.get<ProgramSchedule>(`/programs/${programId}/schedule/`);
      return res.data;
    },
    enabled: !!programId,
    // 409 (not computed), 422 (too large), and 403 (forbidden) are terminal
    // states the page renders directly — retrying them only delays the message.
    retry: (failureCount, error) =>
      classifyProgramScheduleError(error) === 'unknown' && failureCount < 2,
  });
}
