import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useShellStats } from './useShellStats';

/**
 * Unit coverage for the `toShellStats` wire→view transform behind `useShellStats`
 * (#1365). The transform is module-private, so it is exercised through the hook's
 * returned `data`: the snake→camel field map, the `critical_count` alias that now
 * feeds both `criticalCount` and `criticalPathCount` (issue 1325), null
 * passthrough of the schedule-recency fields, and the `enabled: Boolean(projectId)`
 * gate.
 */

const projectId = vi.hoisted<{ current: string | undefined }>(() => ({ current: 'proj-1' }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => projectId.current }));

const getMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const SUMMARY = {
  task_count: 12,
  // Deliberately DISAGREES with the two counts below (which alone would give
  // `critical`). The band is the server's, folding in the manual `Project.health`
  // report, and this hook must copy it rather than reconcile it (#3501).
  health_band: 'at_risk' as const,
  // The provenance the band alone cannot carry (#3525). 'reported' here even
  // though the band DISAGREES with the counts, because the two facts are
  // independent: the source is which branch ran, not whether the outcome differs.
  health_band_source: 'reported' as const,
  monte_carlo_p80: '2026-11-03',
  at_risk_count: 3,
  critical_count: 5,
  at_risk_tasks: [{ id: 't1', name: 'A', wbs: '1' }],
  critical_tasks: [{ id: 't2', name: 'B', wbs: '2' }],
  last_saved: '2026-06-01T10:00:00Z',
  recalculated_at: '2026-06-01T11:00:00Z',
};

describe('useShellStats', () => {
  beforeEach(() => {
    projectId.current = 'proj-1';
    vi.clearAllMocks();
  });

  it('fetches the status summary and maps every field to ShellStats', async () => {
    getMock.mockResolvedValue({ data: SUMMARY });
    const { result } = renderHook(() => useShellStats(), { wrapper: makeWrapper(newClient()) });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/status-summary/');
    const s = result.current.data;
    expect(s?.taskCount).toBe(12);
    expect(s?.healthBand).toBe('at_risk');
    expect(s?.healthBandSource).toBe('reported');
    expect(s?.monteCarlop80).toBe('2026-11-03');
    expect(s?.atRiskCount).toBe(3);
    expect(s?.criticalCount).toBe(5);
    expect(s?.atRiskTasks).toEqual(SUMMARY.at_risk_tasks);
    expect(s?.criticalTasks).toEqual(SUMMARY.critical_tasks);
  });

  it('does not carry last_saved or recalculated_at onto ShellStats', async () => {
    // Both were mapped onto ShellStats and read by nothing (#2903). They are real
    // server values now, so the guard is against re-adding a dead *client* field —
    // the response keys below are deliberately still present in the payload.
    getMock.mockResolvedValue({ data: SUMMARY });
    const { result } = renderHook(() => useShellStats(), { wrapper: makeWrapper(newClient()) });
    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(result.current.data).not.toHaveProperty('lastSaved');
    expect(result.current.data).not.toHaveProperty('recalculatedAt');
  });

  it('derives criticalPathCount from the surviving critical_count alias (issue 1325)', async () => {
    getMock.mockResolvedValue({ data: { ...SUMMARY, critical_count: 7 } });
    const { result } = renderHook(() => useShellStats(), { wrapper: makeWrapper(newClient()) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    // Both ShellStats fields collapse onto the one server field that carried the value.
    expect(result.current.data?.criticalPathCount).toBe(7);
    expect(result.current.data?.criticalCount).toBe(7);
  });

  it('passes a null P80 straight through', async () => {
    // A null p80 now means "no Monte Carlo run exists for this project", which is a
    // fact — before #2903 the server hard-coded it and the value meant nothing.
    getMock.mockResolvedValue({
      data: { ...SUMMARY, monte_carlo_p80: null, last_saved: null, recalculated_at: null },
    });
    const { result } = renderHook(() => useShellStats(), { wrapper: makeWrapper(newClient()) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.monteCarlop80).toBeNull();
  });

  it('always reports onlineUsers as 0 (presence is layered in elsewhere)', async () => {
    getMock.mockResolvedValue({ data: SUMMARY });
    const { result } = renderHook(() => useShellStats(), { wrapper: makeWrapper(newClient()) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.onlineUsers).toBe(0);
  });

  it('does not fetch when there is no active project (enabled gate)', () => {
    projectId.current = undefined;
    renderHook(() => useShellStats(), { wrapper: makeWrapper(newClient()) });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('useShellStats — health band provenance and recovery (#3525)', () => {
  beforeEach(() => {
    projectId.current = 'proj-1';
    vi.clearAllMocks();
  });

  it.each([['reported'], ['derived']] as const)(
    'copies health_band_source through verbatim (%s)',
    async (source) => {
      // Copied, never reconciled against the counts. A band that agrees with the
      // counts can still be `reported`, so any client-side "does the band match
      // the counts?" reconstruction is wrong exactly where nothing looks wrong.
      getMock.mockResolvedValue({ data: { ...SUMMARY, health_band_source: source } });
      const { result } = renderHook(() => useShellStats(), { wrapper: makeWrapper(newClient()) });
      await waitFor(() => expect(result.current.data).toBeDefined());
      expect(result.current.data?.healthBandSource).toBe(source);
    },
  );

  it('reports a failed fetch as an error, not as absent data', async () => {
    // The distinction the whole of #3525's second half turns on: `data` is
    // `undefined` for an in-flight query AND for a failed one, so a consumer that
    // reads only `data` cannot tell "not yet" from "never" and renders its
    // fallback for both. The hook has always exposed `error`; nothing read it.
    getMock.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useShellStats(), { wrapper: makeWrapper(newClient()) });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it('exposes a refetch so a consumer can recover without reloading the app', async () => {
    // Rule 246: retry should re-run the failed request, not `window.location.reload()`.
    getMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ data: SUMMARY });
    const { result } = renderHook(() => useShellStats(), { wrapper: makeWrapper(newClient()) });
    await waitFor(() => expect(result.current.error).not.toBeNull());

    result.current.refetch();

    await waitFor(() => expect(result.current.data?.healthBand).toBe('at_risk'));
    expect(result.current.error).toBeNull();
  });
});
