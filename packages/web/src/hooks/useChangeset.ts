import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api';

/** One structural act, or batched group of acts, on a committed plan (ADR-1477). */
export interface ApiChangesetEntry {
  id: string;
  kind: 'add' | 'move' | 'delete';
  surface: string;
  author: number | null;
  author_name: string | null;
  task_ids: string[];
  task_names: string[];
  reason: string | null;
  reason_state: 'unreasoned' | 'reasoned';
  reason_by_name: string | null;
  finish_before: string | null;
  finish_after: string | null;
  opened_at: string;
  last_act_at: string;
  closed_at: string | null;
  resolved_decision: string | null;
}

/** `GET /projects/{id}/changeset/`. Entries arrive unreasoned first. */
export interface ApiChangeset {
  project_id: string;
  open_count: number;
  unreasoned_count: number;
  reasoned_count: number;
  active_baseline: string | null;
  active_baseline_name: string | null;
  finish_baseline: string | null;
  finish_current: string | null;
  net_delta_days: number | null;
  last_kept_at: string | null;
  entries_since_kept: number;
  entries: ApiChangesetEntry[];
}

export type RebaselineReasonCode =
  | 'approved_scope_change'
  | 'sponsor_moved_commitment'
  | 'external_delay'
  | 'estimate_correction'
  | 'team_change'
  | 'calendar_change';

export interface BaselineDecisionBody {
  kind: 'taken' | 'kept';
  expected_open_count: number;
  reason_code?: RebaselineReasonCode;
  reason?: string;
  note?: string;
}

/**
 * The open changeset for a committed plan. Keyed `['changeset', projectId]`,
 * which the `changeset_updated` board event invalidates (useProjectWebSocket).
 */
export function useChangeset(projectId: string | null | undefined, enabled = true) {
  return useQuery<ApiChangeset>({
    queryKey: ['changeset', projectId],
    queryFn: async () => {
      const res = await apiClient.get<ApiChangeset>(`/projects/${projectId}/changeset/`);
      return res.data;
    },
    enabled: !!projectId && enabled,
  });
}

/** Answer one entry's reason. Set once: the server answers a second write with 409. */
export function useAnswerChangesetReason(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<ApiChangesetEntry, Error, { entryId: string; reason: string }>({
    mutationFn: async ({ entryId, reason }) => {
      const res = await apiClient.patch<ApiChangesetEntry>(
        `/projects/${projectId}/changeset/entries/${entryId}/`,
        { reason },
      );
      return res.data;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['changeset', projectId] });
    },
  });
}

/** Take a new baseline or keep this one. Both exits share one endpoint and one role floor. */
export function useBaselineDecision(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, BaselineDecisionBody>({
    mutationFn: async (body) => {
      const res = await apiClient.post<unknown>(`/projects/${projectId}/baseline-decisions/`, body);
      return res.data;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['changeset', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['baselineDecisions', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['baselines', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
}

/** The server's refusal code on a 409/400, when there is one. */
export function refusalCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  if (typeof data !== 'object' || data === null) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
