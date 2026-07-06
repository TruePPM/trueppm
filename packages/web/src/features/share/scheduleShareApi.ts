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
