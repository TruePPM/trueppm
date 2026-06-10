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

export interface SignalPrivacyPolicy {
  signals: Record<SignalKey, SignalPair>;
  requester_tier: SignalAudience | null;
  can_set_audience: boolean;
  can_raise_ceiling: boolean;
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
 * Mutations for the panel. Each invalidates the policy query on success — a single
 * write can move two values (e.g. lowering a ceiling clamps the audience), so the
 * whole posture is refetched rather than patched field-by-field.
 */
export function useSignalPrivacyMutations(projectId: string | undefined) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['signal-privacy', projectId] });

  const setAudience = useMutation({
    mutationFn: async (vars: { signal: SignalKey; audience: SignalAudience }) => {
      const res = await apiClient.patch<SignalPrivacyPolicy>(
        `/projects/${projectId}/signal-privacy/`,
        vars,
      );
      return res.data;
    },
    onSuccess: invalidate,
  });

  const raiseCeiling = useMutation({
    mutationFn: async (vars: { signal: SignalKey; ceiling: SignalAudience }) => {
      const res = await apiClient.post<SignalPrivacyPolicy>(
        `/projects/${projectId}/signal-privacy/raise-ceiling/`,
        vars,
      );
      return res.data;
    },
    onSuccess: invalidate,
  });

  const ratchetDown = useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<SignalPrivacyPolicy>(
        `/projects/${projectId}/signal-privacy/ratchet-down/`,
        {},
      );
      return res.data;
    },
    onSuccess: invalidate,
  });

  return { setAudience, raiseCeiling, ratchetDown };
}
