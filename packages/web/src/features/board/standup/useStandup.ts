/**
 * Data hook + types for the daily standup walk-the-board surface (ADR-0166, #1278).
 *
 * Consumes the read API `GET /projects/{id}/standup/`: the active sprint's per-assignee
 * walk (done-since-last-working-day / in-progress-today / blockers), assembled
 * server-side so the client never re-derives the calendar-aware window or the aging
 * rule. The query key is `['standup', projectId]` so `useProjectWebSocket` invalidates
 * it on the same card-sync events as the board (it refetches live mid-standup); while
 * standup mode is closed the query is disabled, so a remote move only marks it stale.
 *
 * This is the *current-state, person-by-person* lens; the team-wide *what-changed*
 * delta feed lives separately on the Sprints view (SprintDailyDeltaPanel, ADR-0121).
 */

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { BlockerType } from '@/lib/blocker';

export interface StandupCard {
  id: string;
  name: string;
  status: string;
  story_points: number | null;
  /** Full days the card has sat in its current column, or null when never stamped. */
  dwell_days: number | null;
  /** True when dwell exceeds the column's configured age threshold (#410 / #992). */
  aging: boolean;
  /** Structured impediment class — never the private free-text reason (ADR-0124). */
  blocker_type: BlockerType | null;
  blocked_since: string | null;
}

export interface StandupAssignee {
  id: string;
  name: string;
}

export interface StandupBucket {
  /** The teammate, or null for the Unassigned bucket (always last). */
  assignee: StandupAssignee | null;
  done: StandupCard[];
  in_progress: StandupCard[];
  blockers: StandupCard[];
}

export interface StandupSprint {
  id: string;
  name: string;
  goal: string;
  start_date: string;
  finish_date: string;
}

export interface StandupResponse {
  active: boolean;
  /** "continuous_cadence" | "no_active_sprint" on an inactive payload, else null. */
  reason: string | null;
  sprint: StandupSprint | null;
  generated_at: string;
  window_since: string | null;
  walk: StandupBucket[];
}

export function useStandup(projectId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['standup', projectId],
    queryFn: async () => {
      const res = await apiClient.get<StandupResponse>(`/projects/${projectId}/standup/`);
      return res.data;
    },
    enabled: !!projectId && enabled,
    refetchOnWindowFocus: true,
    staleTime: 15 * 1000,
  });
}
