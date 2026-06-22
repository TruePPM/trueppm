/**
 * Data hooks for the Project Settings → Signal privacy panel (ADR-0104, #553/#854).
 *
 * Types are declared inline (the project convention for settings hooks) so the
 * panel compiles without a schema-codegen run.
 */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

/** The ordered audience ladder (ADR-0104 §1). Order is load-bearing. */
export const SIGNAL_AUDIENCE_LADDER = ['team', 'team_sm', 'team_sm_pm', 'program_shared'] as const;
export type SignalAudience = (typeof SIGNAL_AUDIENCE_LADDER)[number];

/** Short rung labels for the ladder control — the narrow/mobile fallback (#975). */
export const AUDIENCE_RUNG_LABEL: Record<SignalAudience, string> = {
  team: 'Team',
  team_sm: 'SM',
  team_sm_pm: 'PM',
  program_shared: 'Program',
};

/**
 * Full rung labels — spelled out so "SM"/"PM" aren't ambiguous on first read (#975).
 * Shown on the ladder where horizontal space allows, and always exposed via each
 * rung's aria-label + title even when the abbreviation is the visible text.
 */
export const AUDIENCE_RUNG_LABEL_FULL: Record<SignalAudience, string> = {
  team: 'Team',
  team_sm: 'Scrum Master',
  team_sm_pm: 'Project Manager',
  program_shared: 'Program',
};

/** The three governed signals, in display order, with their human copy. */
export const SIGNALS = [
  {
    key: 'velocity',
    title: 'Velocity',
    description: 'Rolling velocity series & per-sprint points.',
  },
  {
    key: 'throughput_rollup',
    title: 'Throughput rollup',
    description:
      "Lets this team's throughput join the program rollup — only when you set it there.",
  },
  {
    key: 'pulse',
    title: 'Retro pulse',
    description: 'Per-sprint mood/energy trend from the retro board. Most private.',
  },
] as const;
export type SignalKey = (typeof SIGNALS)[number]['key'];

export interface SignalPair {
  audience: SignalAudience;
  ceiling: SignalAudience;
}

/** Terminal + open states of a ceiling-raise proposal (mirrors CeilingRaiseStatus, issue 930). */
export type CeilingRaiseStatus = 'open' | 'ratified' | 'rejected' | 'expired';

/** Ratification choices a team member can cast (ADR-0104 Amendment A). */
export type CeilingVoteChoice = 'approve' | 'reject';

/** One team member's recorded vote — the backend exposes the voter as a user id only. */
export interface CeilingVote {
  voter: string;
  choice: CeilingVoteChoice;
  created_at: string;
}

/**
 * A ceiling-raise ratification proposal with its live tally (ADR-0104 Amendment A / issue 930).
 *
 * `proposed_by` and each `votes[].voter` are user ids, not display names — the panel
 * deliberately attributes by "you" + counts rather than naming voters (name-level
 * attribution would chill honest voting, which defeats the privacy posture itself).
 */
export interface CeilingProposal {
  id: string;
  signal: SignalKey;
  from_ceiling: SignalAudience;
  to_ceiling: SignalAudience;
  status: CeilingRaiseStatus;
  proposed_by: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  approve_count: number;
  reject_count: number;
  eligible_count: number;
  threshold: number;
  your_vote: CeilingVoteChoice | null;
  can_vote: boolean;
  votes: CeilingVote[];
}

export interface SignalPrivacyPolicy {
  signals: Record<SignalKey, SignalPair>;
  requester_tier: SignalAudience | null;
  can_set_audience: boolean;
  can_raise_ceiling: boolean;
  /** Whether the requester is an active team member who may cast a ratification vote. */
  can_vote: boolean;
  /**
   * The live OPEN ratification proposal per signal, keyed by signal — present only
   * for signals that currently have one (a raise is pending). Drives the inline
   * pending indicator without a second fetch.
   */
  open_proposals: Partial<Record<SignalKey, CeilingProposal>>;
}

export function audienceRank(value: SignalAudience): number {
  return SIGNAL_AUDIENCE_LADDER.indexOf(value);
}

export function useSignalPrivacy(
  projectId: string | undefined,
): UseQueryResult<SignalPrivacyPolicy> {
  return useQuery({
    queryKey: ['signal-privacy', projectId],
    queryFn: async () => {
      const res = await apiClient.get<SignalPrivacyPolicy>(
        `/projects/${projectId}/signal-privacy/`,
      );
      return res.data;
    },
    enabled: !!projectId,
    staleTime: 60 * 1000,
  });
}

/**
 * Lists ceiling-raise proposals (open + recent resolved), team-readable. Lazy: only
 * fetched when `enabled` (the Decision-history section is expanded) — the page load
 * already carries the open proposals inline via the policy payload.
 */
export function useCeilingProposals(
  projectId: string | undefined,
  enabled: boolean,
): UseQueryResult<CeilingProposal[]> {
  return useQuery({
    queryKey: ['ceiling-proposals', projectId],
    queryFn: async () => {
      const res = await apiClient.get<CeilingProposal[]>(
        `/projects/${projectId}/signal-privacy/ceiling-proposals/`,
      );
      return res.data;
    },
    enabled: !!projectId && enabled,
    staleTime: 30 * 1000,
  });
}

/**
 * Mutations for the panel. Each invalidates the affected queries on success — a single
 * write can move two values (e.g. lowering a ceiling clamps the audience), so the
 * whole posture is refetched rather than patched field-by-field. Vote/withdraw also
 * invalidate the proposals list so the Decision-history audit stays in sync.
 */
export function useSignalPrivacyMutations(projectId: string | undefined) {
  const queryClient = useQueryClient();
  const invalidatePolicy = () =>
    void queryClient.invalidateQueries({ queryKey: ['signal-privacy', projectId] });
  const invalidateAll = () => {
    invalidatePolicy();
    void queryClient.invalidateQueries({ queryKey: ['ceiling-proposals', projectId] });
  };

  const setAudience = useMutation({
    mutationFn: async (vars: { signal: SignalKey; audience: SignalAudience }) => {
      const res = await apiClient.patch<SignalPrivacyPolicy>(
        `/projects/${projectId}/signal-privacy/`,
        vars,
      );
      return res.data;
    },
    onSuccess: invalidatePolicy,
  });

  // A raise now returns 202 + an OPEN proposal (`proposed: true`); a lower/no-op stays
  // 200 + the refreshed policy. Either way we just invalidate and let the refetched
  // policy surface the new posture (and the inline pending card on a raise).
  const raiseCeiling = useMutation({
    mutationFn: async (vars: { signal: SignalKey; ceiling: SignalAudience }) => {
      const res = await apiClient.post<SignalPrivacyPolicy | CeilingProposal>(
        `/projects/${projectId}/signal-privacy/raise-ceiling/`,
        vars,
      );
      return { proposed: res.status === 202 };
    },
    onSuccess: invalidateAll,
  });

  const ratchetDown = useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<SignalPrivacyPolicy>(
        `/projects/${projectId}/signal-privacy/ratchet-down/`,
        {},
      );
      return res.data;
    },
    onSuccess: invalidatePolicy,
  });

  const voteOnProposal = useMutation({
    mutationFn: async (vars: { proposalId: string; choice: CeilingVoteChoice }) => {
      const res = await apiClient.post<CeilingProposal>(
        `/projects/${projectId}/signal-privacy/ceiling-proposals/${vars.proposalId}/vote/`,
        { choice: vars.choice },
      );
      return res.data;
    },
    onSuccess: invalidateAll,
  });

  const withdrawProposal = useMutation({
    mutationFn: async (vars: { proposalId: string }) => {
      const res = await apiClient.post<CeilingProposal>(
        `/projects/${projectId}/signal-privacy/ceiling-proposals/${vars.proposalId}/withdraw/`,
        {},
      );
      return res.data;
    },
    onSuccess: invalidateAll,
  });

  return { setAudience, raiseCeiling, ratchetDown, voteOnProposal, withdrawProposal };
}
