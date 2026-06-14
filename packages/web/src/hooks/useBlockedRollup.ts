import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/**
 * Blocked-task roll-up hooks (ADR-0124) — the read-only triage surfaces for the
 * people who clear blockers. Back `GET /projects/{id}/blocked/` (the PM roll-up)
 * and `GET /sprints/{id}/blocked/` (the SM impediment list). Both return the same
 * reason-free row shape, oldest-blocked first — the private free-text reason is
 * never in this payload (it is read only on the task drawer, gated to the
 * assignee + @-mentioned).
 */

/** One reason-free roll-up row. Mirrors `_blocked_row` on the server. */
export interface BlockedRow {
  task_id: string;
  task_short_id: string;
  title: string;
  assignee: { id: string; username: string } | null;
  /** null when no structured type was recorded (a bare "paused" flag). */
  blocker_type: string | null;
  blocked_since: string | null;
  blocked_age_seconds: number | null;
  blocked_by: { id: string; username: string } | null;
  /** Soft "waiting on" link — NOT a CPM dependency. */
  blocking_task: { id: string; short_id: string; title: string } | null;
}

export interface BlockedRollup {
  count: number;
  blocked: BlockedRow[];
}

interface ProjectBlockedResponse extends BlockedRollup {
  project_id: string;
}
interface SprintBlockedResponse extends BlockedRollup {
  sprint_id: string;
}

/** GET /projects/{id}/blocked/ — flagged-blocked tasks across a project. */
export function useProjectBlocked(
  projectId: string | null | undefined,
): UseQueryResult<BlockedRollup> {
  return useQuery({
    queryKey: ['project-blocked', projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const res = await apiClient.get<ProjectBlockedResponse>(`/projects/${projectId}/blocked/`);
      return { count: res.data.count, blocked: res.data.blocked };
    },
  });
}

/** GET /sprints/{id}/blocked/ — flagged-blocked tasks in one sprint. */
export function useSprintBlocked(
  sprintId: string | null | undefined,
): UseQueryResult<BlockedRollup> {
  return useQuery({
    queryKey: ['sprint-blocked', sprintId],
    enabled: !!sprintId,
    queryFn: async () => {
      const res = await apiClient.get<SprintBlockedResponse>(`/sprints/${sprintId}/blocked/`);
      return { count: res.data.count, blocked: res.data.blocked };
    },
  });
}

/** True when a row carries a structured type — an impediment the SM can route;
 *  a bare flag (no type) is a plain "paused" signal (the split). */
export function isImpediment(row: BlockedRow): boolean {
  return !!row.blocker_type;
}
