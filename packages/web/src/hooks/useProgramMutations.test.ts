import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useCreateProgram,
  useUpdateProgram,
  useDeleteProgram,
  useSplitProgram,
} from './useProgramMutations';

/**
 * Hook-level coverage for the program write mutations (#1365): request shape +
 * default application, cache-invalidation targets, the delete's detail-eviction,
 * and `useSplitProgram`'s verbatim DRF `{detail}` extraction with its generic
 * fallback. Previously only exercised indirectly through component tests.
 */

const postMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({
  apiClient: { post: postMock, patch: patchMock, delete: deleteMock },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe('useCreateProgram', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newClient();
    vi.clearAllMocks();
  });

  it('POSTs to /programs/ applying HYBRID + empty-description defaults', async () => {
    postMock.mockResolvedValue({ data: { id: 'prog-1', name: 'Apollo' } });
    const { result } = renderHook(() => useCreateProgram(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'Apollo' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/programs/', {
      name: 'Apollo',
      description: '',
      methodology: 'HYBRID',
    });
  });

  it('forwards an explicit description and methodology unchanged', async () => {
    postMock.mockResolvedValue({ data: { id: 'prog-1', name: 'Apollo' } });
    const { result } = renderHook(() => useCreateProgram(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'Apollo', description: 'Launch', methodology: 'AGILE' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/programs/', {
      name: 'Apollo',
      description: 'Launch',
      methodology: 'AGILE',
    });
  });

  it('invalidates the programs list on success', async () => {
    postMock.mockResolvedValue({ data: { id: 'prog-1', name: 'Apollo' } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateProgram(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'Apollo' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['programs'] });
  });
});

describe('useUpdateProgram', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newClient();
    vi.clearAllMocks();
  });

  it('PATCHes the changed subset and invalidates both the list and the detail', async () => {
    patchMock.mockResolvedValue({ data: { id: 'prog-1', name: 'Renamed' } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateProgram(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ programId: 'prog-1', patch: { name: 'Renamed' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/programs/prog-1/', { name: 'Renamed' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['programs'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['programs', 'prog-1'] });
  });
});

describe('useDeleteProgram', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newClient();
    vi.clearAllMocks();
  });

  it('DELETEs, invalidates the list, and evicts the cached per-program detail', async () => {
    deleteMock.mockResolvedValue({ data: undefined });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const removeSpy = vi.spyOn(qc, 'removeQueries');
    const { result } = renderHook(() => useDeleteProgram(), { wrapper: makeWrapper(qc) });
    result.current.mutate('prog-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteMock).toHaveBeenCalledWith('/programs/prog-1/');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['programs'] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ['programs', 'prog-1'] });
  });
});

describe('useSplitProgram', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = newClient();
    vi.clearAllMocks();
  });

  it('surfaces a DRF 400 {detail} verbatim as the mutation error message', async () => {
    postMock.mockRejectedValue({
      response: { data: { detail: 'Project X is not a project of this program.' } },
    });
    const { result } = renderHook(() => useSplitProgram(), { wrapper: makeWrapper(qc) });
    result.current.mutate({
      programId: 'prog-1',
      splits: [{ name: 'Sub', project_ids: ['p1'] }],
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Project X is not a project of this program.');
  });

  it('falls back to the underlying error message when there is no detail', async () => {
    postMock.mockRejectedValue(new Error('Network Error'));
    const { result } = renderHook(() => useSplitProgram(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ programId: 'prog-1', splits: [] });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Network Error');
  });

  it('invalidates the programs cache on a successful split', async () => {
    postMock.mockResolvedValue({ data: { program: { id: 'prog-1' }, sub_programs: [] } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSplitProgram(), { wrapper: makeWrapper(qc) });
    result.current.mutate({
      programId: 'prog-1',
      splits: [{ name: 'Sub', project_ids: ['p1'] }],
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['programs'] });
  });
});
