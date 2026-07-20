/**
 * Hooks for sprint-planning estimation poker (ADR-0179, issue 863).
 *
 * `useSprintPoker` reads the sprint's live round(s); the mutations drive the lifecycle
 * (open / vote / reveal / reopen / commit / cancel). Voting is optimistic — the caller's
 * card flips immediately and rolls back on error. A `poker_session_updated` WebSocket event
 * invalidates the query so every participant's screen converges.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { toast } from '@/components/Toast/toast';
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
    // Opening a round is a facilitator write with no optimistic UI, so a failure
    // is otherwise silent — the "Estimate" button just does nothing (#2150).
    onError: () => {
      toast.error("Couldn't open the estimation round — try again.");
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
      // Roll the optimistic card flip back, then tell the voter their vote did
      // not land — the rollback alone is visually silent (#2150).
      if (ctx?.previous) qc.setQueryData(pokerKey(sprintId), ctx.previous);
      toast.error("Couldn't record your vote — try again.");
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

const SESSION_ACTION_ERROR: Record<'reveal' | 'reopen' | 'cancel', string> = {
  reveal: "Couldn't reveal the estimates — try again.",
  reopen: "Couldn't reopen the round — try again.",
  cancel: "Couldn't cancel the round — try again.",
};

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
    // Facilitator lifecycle writes have no optimistic UI, so a failure is
    // otherwise silent — the round just doesn't change state (#2150).
    onError: () => {
      toast.error(SESSION_ACTION_ERROR[action]);
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
    // Committing the agreed estimate has no optimistic UI; a failure otherwise
    // leaves the story_points unwritten with no signal (#2150).
    onError: () => {
      toast.error("Couldn't commit the estimate — try again.");
    },
  });
}
