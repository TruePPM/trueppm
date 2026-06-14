import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  seedImportErrors,
  useLoadSampleProgram,
  useImportProgramSeed,
  useRemoveSampleProgram,
} from './useProgramSeedIo';

describe('seedImportErrors', () => {
  it('extracts the server error list from a 400 response', () => {
    const error = { response: { data: { errors: ['$.program.name: required', '$.x: bad'] } } };
    expect(seedImportErrors(error)).toEqual(['$.program.name: required', '$.x: bad']);
  });

  it('returns an empty list when there is no structured error payload', () => {
    expect(seedImportErrors(new Error('network'))).toEqual([]);
    expect(seedImportErrors(undefined)).toEqual([]);
    expect(seedImportErrors({ response: { data: {} } })).toEqual([]);
  });
});

const postMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { id: 'prog-new', name: 'Atlas' } }),
);

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('seed-io mutations invalidate the sidebar project list', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
  });

  // Regression: the sidebar project list keys on ['projects'], which is NOT a
  // child of ['programs'], so a ['programs']-only invalidation left the newly
  // created sample projects invisible until a manual page refresh.
  it('useLoadSampleProgram invalidates both ["programs"] and ["projects"]', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useLoadSampleProgram(), { wrapper: makeWrapper(qc) });

    result.current.mutate(undefined);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/programs/load-sample/', {});
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['programs'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });

  it('useImportProgramSeed invalidates both ["programs"] and ["projects"]', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useImportProgramSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate(new File(['{}'], 'seed.json', { type: 'application/json' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['programs'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });

  it('useRemoveSampleProgram invalidates both ["programs"] and ["projects"]', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useRemoveSampleProgram(), { wrapper: makeWrapper(qc) });

    result.current.mutate('prog-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/programs/prog-1/remove-sample/');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['programs'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });
});
