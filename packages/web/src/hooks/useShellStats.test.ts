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
    expect(s?.monteCarlop80).toBe('2026-11-03');
    expect(s?.atRiskCount).toBe(3);
    expect(s?.criticalCount).toBe(5);
    expect(s?.atRiskTasks).toEqual(SUMMARY.at_risk_tasks);
    expect(s?.criticalTasks).toEqual(SUMMARY.critical_tasks);
    expect(s?.lastSaved).toBe('2026-06-01T10:00:00Z');
    expect(s?.recalculatedAt).toBe('2026-06-01T11:00:00Z');
  });

  it('derives criticalPathCount from the surviving critical_count alias (issue 1325)', async () => {
    getMock.mockResolvedValue({ data: { ...SUMMARY, critical_count: 7 } });
    const { result } = renderHook(() => useShellStats(), { wrapper: makeWrapper(newClient()) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    // Both ShellStats fields collapse onto the one server field that carried the value.
    expect(result.current.data?.criticalPathCount).toBe(7);
    expect(result.current.data?.criticalCount).toBe(7);
  });

  it('passes nullable schedule-recency fields straight through as null', async () => {
    getMock.mockResolvedValue({
      data: { ...SUMMARY, monte_carlo_p80: null, last_saved: null, recalculated_at: null },
    });
    const { result } = renderHook(() => useShellStats(), { wrapper: makeWrapper(newClient()) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.monteCarlop80).toBeNull();
    expect(result.current.data?.lastSaved).toBeNull();
    expect(result.current.data?.recalculatedAt).toBeNull();
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
