/**
 * usePhaseReorder unit tests (#784 coverage backfill, ADR-0046).
 *
 * The phase-reorder PATCH carries optimistic ordering state in the caller, so its
 * three branches each have a UI consequence that must not silently regress:
 *  - the request body shape (id + server_version) the server contract depends on;
 *  - a 409 surfaced as the typed PhaseVersionConflictError + an immediate
 *    `['tasks']` invalidate so the UI snaps back to the authoritative server order;
 *  - any other failure rethrown verbatim (no false conflict, no invalidate).
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { usePhaseReorder, PhaseVersionConflictError, type PhaseEntry } from './usePhaseReorder';

const { patchMock } = vi.hoisted(() => ({
  patchMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { patch: patchMock },
}));

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const ENTRIES: PhaseEntry[] = [
  { id: 'ph1', serverVersion: 3 },
  { id: 'ph2', serverVersion: 5 },
];

beforeEach(() => {
  vi.clearAllMocks();
  patchMock.mockResolvedValue({ data: {} });
});

describe('usePhaseReorder', () => {
  it('sends the ADR-0046 body shape (id + server_version) to the reorder endpoint', async () => {
    const qc = makeQC();
    const { result } = renderHook(() => usePhaseReorder('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate(ENTRIES);

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith('/projects/p1/phases/reorder/', {
      phases: [
        { id: 'ph1', server_version: 3 },
        { id: 'ph2', server_version: 5 },
      ],
    });
  });

  it('invalidates the project tasks on success so the new order re-fetches', async () => {
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => usePhaseReorder('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate(ENTRIES);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] });
  });

  it('maps a 409 to PhaseVersionConflictError and invalidates tasks to snap to server order', async () => {
    patchMock.mockRejectedValueOnce({ response: { status: 409 } });
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => usePhaseReorder('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate(ENTRIES);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(PhaseVersionConflictError);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'p1'] });
  });

  it('rethrows a non-conflict error verbatim and does NOT invalidate', async () => {
    const serverError = { response: { status: 500 } };
    patchMock.mockRejectedValueOnce(serverError);
    const qc = makeQC();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => usePhaseReorder('p1'), { wrapper: makeWrapper(qc) });

    result.current.mutate(ENTRIES);

    await waitFor(() => expect(result.current.isError).toBe(true));
    // The original error is surfaced unchanged — never a false version conflict.
    expect(result.current.error).not.toBeInstanceOf(PhaseVersionConflictError);
    expect(result.current.error).toBe(serverError);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
