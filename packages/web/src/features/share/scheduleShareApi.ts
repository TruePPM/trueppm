import axios from 'axios';
import { classifyShareError, type PublicShareErrorKind } from './shareApi';

/**
 * Public schedule share API (#1486, ADR-0265). Sibling of `shareApi.ts`. Uses a
 * BARE axios call — NOT the shared `apiClient` — because the public viewer has no
 * auth token and must not trip apiClient's request-interceptor (bearer injection)
 * or its 401 session-expiry flow. Error classification is shared with the board
 * viewer (410 → revoked, 404 → not_found).
 */

export interface PublicScheduleTask {
  short_id: string;
  name: string;
  wbs_path: string;
  duration: number;
  planned_start: string | null;
  early_start: string | null;
  early_finish: string | null;
  /**
   * The task's SPAN start (ADR-0752 §8) — a deliberate widening of this
   * projection: for an in-progress task, scheduled_start IS actual_start
   * (`_public_schedule_task`, `share_services.py`), which the projection
   * otherwise withholds. Included so the public Gantt draws the same bar the
   * authenticated product does, rather than a remaining-work-window bar that
   * shrinks as progress is logged.
   */
  scheduled_start: string | null;
  is_milestone: boolean;
  is_critical: boolean;
  percent_complete: number;
  status: string;
  assignee: string | null;
}

export interface PublicScheduleDependency {
  predecessor_short_id: string;
  successor_short_id: string;
  dep_type: string;
  lag: number;
}

export interface PublicSchedule {
  content_kind: string;
  project: { name: string; short_id: string };
  tasks: PublicScheduleTask[];
  dependencies: PublicScheduleDependency[];
  show_assignees: boolean;
  /** When false the server withheld every milestone row — none reach this payload. */
  show_milestone_dates: boolean;
  truncated: boolean;
}

export type { PublicShareErrorKind };
export { classifyShareError };

export async function fetchPublicSchedule(token: string): Promise<PublicSchedule> {
  const res = await axios.get<PublicSchedule>(
    `/api/v1/share/schedule/${encodeURIComponent(token)}/`,
  );
  return res.data;
}
