import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  AUDIENCE_RUNG_LABEL,
  AUDIENCE_RUNG_LABEL_FULL,
  SIGNAL_AUDIENCE_LADDER,
  SIGNALS,
  audienceRank,
  useCeilingProposals,
  useSignalPrivacy,
  useSignalPrivacyMutations,
} from './useSignalPrivacy';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock, post: postMock, patch: patchMock } }));

let qc: QueryClient;
let invalidate: MockInstance<QueryClient['invalidateQueries']>;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  [getMock, postMock, patchMock].forEach((m) => m.mockReset());
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
});

describe('audience ladder', () => {
  it('ranks by ladder position and labels every rung in both forms', () => {
    expect(SIGNAL_AUDIENCE_LADDER.map(audienceRank)).toEqual([0, 1, 2, 3]);
    expect(audienceRank('program_shared')).toBeGreaterThan(audienceRank('team'));
    for (const rung of SIGNAL_AUDIENCE_LADDER) {
      expect(AUDIENCE_RUNG_LABEL[rung]).toBeTruthy();
      expect(AUDIENCE_RUNG_LABEL_FULL[rung]).toBeTruthy();
    }
    expect(AUDIENCE_RUNG_LABEL_FULL.team_sm).toBe('Scrum Master');
    expect(SIGNALS.map((s) => s.key)).toEqual(['velocity', 'throughput_rollup', 'pulse']);
  });
});

describe('reads', () => {
  it('fetches the policy for a project and is idle without one', async () => {
    getMock.mockResolvedValue({ data: { signals: {}, can_vote: false } });
    const { result } = renderHook(() => useSignalPrivacy('p1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/projects/p1/signal-privacy/');
    const { result: idle } = renderHook(() => useSignalPrivacy(undefined), { wrapper });
    expect(idle.current.fetchStatus).toBe('idle');
  });

  it('fetches proposals lazily — only when the section is expanded', async () => {
    getMock.mockResolvedValue({ data: [] });
    const { result: collapsed } = renderHook(() => useCeilingProposals('p1', false), { wrapper });
    expect(collapsed.current.fetchStatus).toBe('idle');
    const { result } = renderHook(() => useCeilingProposals('p1', true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/projects/p1/signal-privacy/ceiling-proposals/');
  });
});

describe('useSignalPrivacyMutations', () => {
  it('setAudience patches and refetches the policy only', async () => {
    patchMock.mockResolvedValue({ data: {} });
    const { result } = renderHook(() => useSignalPrivacyMutations('p1'), { wrapper });
    await act(async () => {
      await result.current.setAudience.mutateAsync({ signal: 'velocity', audience: 'team_sm' });
    });
    expect(patchMock).toHaveBeenCalledWith('/projects/p1/signal-privacy/', {
      signal: 'velocity',
      audience: 'team_sm',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['signal-privacy', 'p1'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['ceiling-proposals', 'p1'] });
  });

  it('raiseCeiling reports whether the server opened a proposal (202) or applied it (200)', async () => {
    const { result } = renderHook(() => useSignalPrivacyMutations('p1'), { wrapper });
    postMock.mockResolvedValueOnce({ status: 202, data: {} });
    let outcome: { proposed: boolean } | undefined;
    await act(async () => {
      outcome = await result.current.raiseCeiling.mutateAsync({
        signal: 'pulse',
        ceiling: 'team_sm_pm',
      });
    });
    expect(outcome).toEqual({ proposed: true });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/signal-privacy/raise-ceiling/', {
      signal: 'pulse',
      ceiling: 'team_sm_pm',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['ceiling-proposals', 'p1'] });

    postMock.mockResolvedValueOnce({ status: 200, data: {} });
    await act(async () => {
      outcome = await result.current.raiseCeiling.mutateAsync({ signal: 'pulse', ceiling: 'team' });
    });
    expect(outcome).toEqual({ proposed: false });
  });

  it('ratchetDown posts an empty body and refetches the policy', async () => {
    postMock.mockResolvedValue({ data: {} });
    const { result } = renderHook(() => useSignalPrivacyMutations('p1'), { wrapper });
    await act(async () => {
      await result.current.ratchetDown.mutateAsync();
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/signal-privacy/ratchet-down/', {});
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['signal-privacy', 'p1'] });
  });

  it('vote and withdraw address the proposal and refresh both the policy and the history', async () => {
    postMock.mockResolvedValue({ data: {} });
    const { result } = renderHook(() => useSignalPrivacyMutations('p1'), { wrapper });
    await act(async () => {
      await result.current.voteOnProposal.mutateAsync({ proposalId: 'cp1', choice: 'approve' });
      await result.current.withdrawProposal.mutateAsync({ proposalId: 'cp1' });
    });
    expect(postMock).toHaveBeenCalledWith(
      '/projects/p1/signal-privacy/ceiling-proposals/cp1/vote/',
      { choice: 'approve' },
    );
    expect(postMock).toHaveBeenCalledWith(
      '/projects/p1/signal-privacy/ceiling-proposals/cp1/withdraw/',
      {},
    );
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(keys.filter((k) => k.includes('ceiling-proposals'))).toHaveLength(2);
    expect(keys.filter((k) => k.includes('signal-privacy'))).toHaveLength(2);
  });
});
