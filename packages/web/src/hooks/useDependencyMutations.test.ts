/**
 * Tests for useDependencyMutations — covers useCreateDependency, useUpdateDependency,
 * and useDeleteDependency. Verifies mutationFn endpoint shape, onSuccess invalidation,
 * and the projectId null branch for each hook.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useCreateDependency,
  useUpdateDependency,
  useDeleteDependency,
} from './useDependencyMutations';

// ---------------------------------------------------------------------------
// API client mock
// ---------------------------------------------------------------------------

const { postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  postMock: vi.fn().mockResolvedValue({
    data: {
      id: 'dep-1',
      predecessor: 'ta',
      successor: 'tb',
      dep_type: 'FS',
      lag: 0,
      is_critical: false,
    },
  }),
  patchMock: vi.fn().mockResolvedValue({
    data: {
      id: 'dep-1',
      predecessor: 'ta',
      successor: 'tb',
      dep_type: 'SS',
      lag: 1,
      is_critical: false,
    },
  }),
  deleteMock: vi.fn().mockResolvedValue({ data: {} }),
}));

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock, patch: patchMock, delete: deleteMock },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// useCreateDependency
// ---------------------------------------------------------------------------

describe('useCreateDependency', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = makeQC();
    vi.clearAllMocks();
    postMock.mockResolvedValue({
      data: {
        id: 'dep-1',
        predecessor: 'ta',
        successor: 'tb',
        dep_type: 'FS',
        lag: 0,
        is_critical: false,
      },
    });
  });

  it('POSTs to /dependencies/ with lag defaulted to 0 when omitted', async () => {
    const { result } = renderHook(() => useCreateDependency('proj1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ predecessor: 'ta', successor: 'tb', dep_type: 'FS' });

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/dependencies/', {
        predecessor: 'ta',
        successor: 'tb',
        dep_type: 'FS',
        lag: 0,
      }),
    );
  });

  it('POSTs with the explicit lag when provided', async () => {
    const { result } = renderHook(() => useCreateDependency('proj1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ predecessor: 'ta', successor: 'tb', dep_type: 'SS', lag: 3 });

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/dependencies/', {
        predecessor: 'ta',
        successor: 'tb',
        dep_type: 'SS',
        lag: 3,
      }),
    );
  });

  it('invalidates dependencies cache with projectId on success', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateDependency('proj1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ predecessor: 'ta', successor: 'tb', dep_type: 'FS' });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['dependencies', 'proj1'],
      }),
    );
  });

  it('invalidates with undefined when projectId is null', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateDependency(null), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ predecessor: 'ta', successor: 'tb', dep_type: 'FS' });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['dependencies', undefined],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// useUpdateDependency
// ---------------------------------------------------------------------------

describe('useUpdateDependency', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = makeQC();
    vi.clearAllMocks();
    patchMock.mockResolvedValue({ data: {} });
  });

  it('PATCHes to /dependencies/{id}/ with the updated fields', async () => {
    const { result } = renderHook(() => useUpdateDependency('proj1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ id: 'dep-1', dep_type: 'SS', lag: 2 });

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/dependencies/dep-1/', {
        dep_type: 'SS',
        lag: 2,
      }),
    );
  });

  it('invalidates dependencies cache on success', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateDependency('proj1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ id: 'dep-1', dep_type: 'FF' });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['dependencies', 'proj1'],
      }),
    );
  });

  it('invalidates with undefined when projectId is null', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateDependency(null), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate({ id: 'dep-1', lag: 5 });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['dependencies', undefined],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// useDeleteDependency
// ---------------------------------------------------------------------------

describe('useDeleteDependency', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = makeQC();
    vi.clearAllMocks();
    deleteMock.mockResolvedValue({ data: {} });
  });

  it('issues DELETE to /dependencies/{id}/', async () => {
    const { result } = renderHook(() => useDeleteDependency('proj1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate('dep-1');

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith('/dependencies/dep-1/'),
    );
  });

  it('invalidates dependencies cache on success', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteDependency('proj1'), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate('dep-1');

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['dependencies', 'proj1'],
      }),
    );
  });

  it('invalidates with undefined when projectId is null', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteDependency(null), {
      wrapper: makeWrapper(qc),
    });

    result.current.mutate('dep-1');

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['dependencies', undefined],
      }),
    );
  });
});
