import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useTaskDependencies,
  useTaskRisks,
  severityRagBand,
  severityDotCount,
} from './useTaskDependencies';

// ---------------------------------------------------------------------------
// API client mock
// ---------------------------------------------------------------------------

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: getMock },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

// ---------------------------------------------------------------------------
// useTaskDependencies
// ---------------------------------------------------------------------------

describe('useTaskDependencies', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = makeQC();
    vi.clearAllMocks();
  });

  it('returns isLoading=false and empty arrays when taskId is null (disabled query)', () => {
    const { result } = renderHook(() => useTaskDependencies(null), {
      wrapper: makeWrapper(qc),
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.predecessors).toEqual([]);
    expect(result.current.successors).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('fetches edges and splits into predecessors and successors', async () => {
    getMock.mockResolvedValueOnce({
      data: {
        results: [
          { id: 'e1', predecessor: 'ta', successor: 't1', dep_type: 'FS', lag: 0 },
          { id: 'e2', predecessor: 't1', successor: 'tb', dep_type: 'FS', lag: 2 },
        ],
      },
    });

    const { result } = renderHook(() => useTaskDependencies('t1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.predecessors).toHaveLength(1);
    expect(result.current.predecessors[0]).toEqual({
      id: 'e1',
      predecessorId: 'ta',
      successorId: 't1',
      depType: 'FS',
      lag: 0,
    });

    expect(result.current.successors).toHaveLength(1);
    expect(result.current.successors[0]).toEqual({
      id: 'e2',
      predecessorId: 't1',
      successorId: 'tb',
      depType: 'FS',
      lag: 2,
    });
  });

  it('calls the correct endpoint with the task id as a param', async () => {
    getMock.mockResolvedValueOnce({ data: { results: [] } });

    const { result } = renderHook(() => useTaskDependencies('task-abc'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(getMock).toHaveBeenCalledWith('/dependencies/', {
      params: { task: 'task-abc' },
    });
  });

  it('handles empty results — no predecessors, no successors', async () => {
    getMock.mockResolvedValueOnce({ data: { results: [] } });

    const { result } = renderHook(() => useTaskDependencies('t1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.predecessors).toEqual([]);
    expect(result.current.successors).toEqual([]);
  });

  it('propagates error from the API call', async () => {
    getMock.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useTaskDependencies('t1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('Network error');
  });
});

// ---------------------------------------------------------------------------
// useTaskRisks
// ---------------------------------------------------------------------------

describe('useTaskRisks', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = makeQC();
    vi.clearAllMocks();
  });

  it('returns isLoading=false and empty risks when projectId is null (disabled query)', () => {
    const { result } = renderHook(() => useTaskRisks(null, 't1'), {
      wrapper: makeWrapper(qc),
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.risks).toEqual([]);
  });

  it('returns isLoading=false and empty risks when taskId is null (disabled query)', () => {
    const { result } = renderHook(() => useTaskRisks('proj1', null), {
      wrapper: makeWrapper(qc),
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.risks).toEqual([]);
  });

  it('fetches and maps risks correctly', async () => {
    getMock.mockResolvedValueOnce({
      data: {
        results: [
          {
            id: 'r1',
            short_id: 'RSK-001',
            title: 'Budget risk',
            status: 'OPEN',
            probability: 3,
            impact: 4,
            severity: 12,
            owner: 'user-1',
          },
        ],
      },
    });

    const { result } = renderHook(() => useTaskRisks('proj1', 't1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.risks).toHaveLength(1);
    expect(result.current.risks[0]).toEqual({
      id: 'r1',
      shortId: 'RSK-001',
      title: 'Budget risk',
      status: 'OPEN',
      severity: 12,
      ownerId: 'user-1',
    });
  });

  it('calls the correct endpoint with project and task params', async () => {
    getMock.mockResolvedValueOnce({ data: { results: [] } });

    const { result } = renderHook(() => useTaskRisks('proj1', 't1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(getMock).toHaveBeenCalledWith('/projects/proj1/risks/', {
      params: { task: 't1' },
    });
  });

  it('maps owner: null to ownerId: null', async () => {
    getMock.mockResolvedValueOnce({
      data: {
        results: [
          {
            id: 'r2',
            short_id: 'RSK-002',
            title: 'Schedule risk',
            status: 'MITIGATING',
            probability: 2,
            impact: 3,
            severity: 6,
            owner: null,
          },
        ],
      },
    });

    const { result } = renderHook(() => useTaskRisks('proj1', 't1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.risks[0].ownerId).toBeNull();
  });

  it('propagates API error', async () => {
    getMock.mockRejectedValueOnce(new Error('Forbidden'));

    const { result } = renderHook(() => useTaskRisks('proj1', 't1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('Forbidden');
  });
});

describe('severityRagBand', () => {
  it('returns null for null/zero severity', () => {
    expect(severityRagBand(null)).toBeNull();
    expect(severityRagBand(undefined)).toBeNull();
    expect(severityRagBand(0)).toBeNull();
  });

  it('maps 1–5 to green', () => {
    for (const s of [1, 2, 5]) expect(severityRagBand(s)).toBe('green');
  });

  it('maps 6–14 to amber', () => {
    for (const s of [6, 9, 14]) expect(severityRagBand(s)).toBe('amber');
  });

  it('maps 15–25 to red', () => {
    for (const s of [15, 20, 25]) expect(severityRagBand(s)).toBe('red');
  });
});

describe('severityDotCount', () => {
  it('returns 0 for null/zero severity', () => {
    expect(severityDotCount(null)).toBe(0);
    expect(severityDotCount(undefined)).toBe(0);
    expect(severityDotCount(0)).toBe(0);
  });

  it('maps the 5-tier register: MINIMAL/LOW/MEDIUM/HIGH/CRITICAL', () => {
    expect(severityDotCount(1)).toBe(1);   // MINIMAL
    expect(severityDotCount(2)).toBe(2);   // LOW
    expect(severityDotCount(5)).toBe(2);
    expect(severityDotCount(6)).toBe(3);   // MEDIUM
    expect(severityDotCount(11)).toBe(3);
    expect(severityDotCount(12)).toBe(4);  // HIGH
    expect(severityDotCount(19)).toBe(4);
    expect(severityDotCount(20)).toBe(5);  // CRITICAL
    expect(severityDotCount(25)).toBe(5);
  });
});
