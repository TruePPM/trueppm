import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { LinkType } from '@/types';
import type { PaginatedResponse } from '@/api/types';

/**
 * D5 ExternalTaskCard — the minimal, redacted cross-project task card
 * (ADR-0120 D5). Scheduling facts only; the API deliberately omits
 * description, assignee, status, and points so a reviewer can name the
 * counterpart task without leaking team-private data from a project they may
 * not be able to open.
 */
export interface ExternalTaskCard {
  id: string;
  title: string;
  hex_id: string;
  project_id: string;
  project_name: string;
  is_milestone: boolean;
  early_start: string | null;
  early_finish: string | null;
  is_critical: boolean | null;
}

interface ApiPendingDependency {
  id: string;
  predecessor: string;
  successor: string;
  dep_type: LinkType;
  lag: number;
  pending_acceptance: boolean;
  predecessor_card: ExternalTaskCard | null;
  successor_card: ExternalTaskCard | null;
}

export interface PendingIncomingDep {
  id: string;
  depType: LinkType;
  lag: number;
  /** The upstream (blocking) task in the sibling project — D5 card. */
  predecessorCard: ExternalTaskCard | null;
  /** The reviewer's own task the edge would newly constrain — D5 card. */
  successorCard: ExternalTaskCard | null;
}

export interface PendingIncomingDepsResult {
  items: PendingIncomingDep[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * GET /api/v1/dependencies/?pending_for_project=<projectId> — the *incoming*
 * pending cross-project edges a downstream (successor) team must review
 * (ADR-0120 D2). Only edges whose successor sits in this project and that are
 * still inert (pending_acceptance) come back; the server also narrows to what
 * the caller may already see. Backs the schedule review banner.
 */
export function usePendingIncomingDeps(projectId: string | null): PendingIncomingDepsResult {
  const query = useQuery({
    queryKey: ['pending-incoming-deps', projectId ?? undefined],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<ApiPendingDependency>>('/dependencies/', {
        params: { pending_for_project: projectId },
      });
      return res.data.results;
    },
    enabled: !!projectId,
  });

  const items: PendingIncomingDep[] = (query.data ?? []).map((d) => ({
    id: d.id,
    depType: d.dep_type,
    lag: d.lag,
    predecessorCard: d.predecessor_card,
    successorCard: d.successor_card,
  }));

  return {
    items,
    isLoading: query.isLoading,
    error: query.error,
  };
}

export type ResolveAction = 'accept' | 'reject';

/**
 * POST /api/v1/dependencies/{id}/accept|reject/ — resolve a pending
 * cross-project edge (ADR-0120 D2 / C2). The server is the real gate: only a
 * Scheduler+ on the successor's project may act, so this mutation only wires
 * the affordance — a caller without authority gets a 403.
 *
 * No offline queue: consent is a deliberate, one-shot decision on shared
 * cross-team state, not a field edit to reconcile later — the affordance is
 * disabled offline at the call site instead. On success we invalidate the
 * pending list (the row is gone), and the dependency + tasks queries because an
 * accept binds the edge and cascades CPM across both endpoints.
 */
export function useResolvePendingDependency(projectId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, action }: { id: string; action: ResolveAction }) => {
      const res = await apiClient.post<ApiPendingDependency>(`/dependencies/${id}/${action}/`);
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['pending-incoming-deps', projectId ?? undefined],
      });
      void queryClient.invalidateQueries({
        queryKey: ['dependencies', projectId ?? undefined],
      });
      void queryClient.invalidateQueries({
        queryKey: ['tasks', projectId ?? undefined],
      });
    },
  });
}
