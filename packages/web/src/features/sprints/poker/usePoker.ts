/**
 * Hooks for sprint-planning estimation poker (ADR-0179, #863).
 *
 * `useSprintPoker` reads the sprint's live round(s); the mutations drive the lifecycle
 * (open / vote / reveal / reopen / commit / cancel). Voting is optimistic — the caller's
 * card flips immediately and rolls back on error. A `poker_session_updated` WebSocket event
 * invalidates the query so every participant's screen converges.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PokerSession } from '@/types';

export const pokerKey = (sprintId: string) => ['poker', sprintId];

/** GET /api/v1/sprints/{sprintId}/poker/ — the sprint's live rounds (open or revealed). */
export function useSprintPoker(sprintId: string | null | undefined, enabled = true) {
  const query = useQuery({
    queryKey: pokerKey(sprintId ?? ''),
    queryFn: async () => {
      const res = await apiClient.get<PokerSession[]>(`/sprints/${sprintId}/poker/`);
      return res.data;
    },
    enabled: !!sprintId && enabled,
  });
  return {
    sessions: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

interface OpenVars {
  sprintId: string;
  taskId: string;
}

/** POST /api/v1/sprints/{sprintId}/poker/ — open a round for a task (facilitator). */
export function useOpenPoker() {
  const qc = useQueryClient();
  return useMutation<PokerSession, Error, OpenVars>({
    mutationFn: async ({ sprintId, taskId }) => {
      const res = await apiClient.post<PokerSession>(`/sprints/${sprintId}/poker/`, {
        task: taskId,
      });
      return res.data;
    },
    onSuccess: (_d, { sprintId }) => {
      void qc.invalidateQueries({ queryKey: pokerKey(sprintId) });
    },
  });
}

interface VoteVars {
  sprintId: string;
  sessionId: string;
  value: number | null;
  comment?: string;
}

interface VoteContext {
  previous: PokerSession[] | undefined;
}

/** POST /api/v1/poker/{sessionId}/vote/ — upsert my vote, optimistically (rollback on error). */
export function useCastVote() {
  const qc = useQueryClient();
  return useMutation<PokerSession, Error, VoteVars, VoteContext>({
    mutationFn: async ({ sessionId, value, comment }) => {
      const res = await apiClient.post<PokerSession>(`/poker/${sessionId}/vote/`, {
        value,
        comment: comment ?? '',
      });
      return res.data;
    },
    onMutate: async ({ sprintId, sessionId, value, comment }) => {
      const key = pokerKey(sprintId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<PokerSession[]>(key);
      // Flip the caller's own card immediately; the server's authoritative row replaces it.
      qc.setQueryData<PokerSession[]>(key, (rows) =>
        (rows ?? []).map((s) =>
          s.id === sessionId ? { ...s, my_vote: { value, comment: comment ?? '' } } : s,
        ),
      );
      return { previous };
    },
    onError: (_e, { sprintId }, ctx) => {
      if (ctx?.previous) qc.setQueryData(pokerKey(sprintId), ctx.previous);
    },
    onSettled: (_d, _e, { sprintId }) => {
      void qc.invalidateQueries({ queryKey: pokerKey(sprintId) });
    },
  });
}

interface ActionVars {
  sprintId: string;
  sessionId: string;
}

function useSessionAction(action: 'reveal' | 'reopen' | 'cancel') {
  const qc = useQueryClient();
  return useMutation<PokerSession, Error, ActionVars>({
    mutationFn: async ({ sessionId }) => {
      const res = await apiClient.post<PokerSession>(`/poker/${sessionId}/${action}/`);
      return res.data;
    },
    onSuccess: (_d, { sprintId }) => {
      void qc.invalidateQueries({ queryKey: pokerKey(sprintId) });
    },
  });
}

export const useRevealPoker = () => useSessionAction('reveal');
export const useReopenPoker = () => useSessionAction('reopen');
export const useCancelPoker = () => useSessionAction('cancel');

interface CommitVars {
  sprintId: string;
  sessionId: string;
  points: number;
}

/** POST /api/v1/poker/{sessionId}/commit/ — write the agreed Task.story_points (facilitator). */
export function useCommitPoker() {
  const qc = useQueryClient();
  return useMutation<PokerSession, Error, CommitVars>({
    mutationFn: async ({ sessionId, points }) => {
      const res = await apiClient.post<PokerSession>(`/poker/${sessionId}/commit/`, { points });
      return res.data;
    },
    onSuccess: (_d, { sprintId }) => {
      void qc.invalidateQueries({ queryKey: pokerKey(sprintId) });
      // The committed story_points lands on the task → refresh the planning backlog.
      void qc.invalidateQueries({ queryKey: ['sprint-backlog'] });
    },
  });
}
