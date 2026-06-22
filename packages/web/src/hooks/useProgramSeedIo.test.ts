import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  seedImportErrors,
  useExportProgramSeed,
  useExportProjectSeed,
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
const getMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock, get: getMock },
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

describe('useExportProgramSeed download flow', () => {
  let qc: QueryClient;
  let clickSpy: MockInstance<() => void>;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
    getMock.mockResolvedValue({ data: new Blob(['{}'], { type: 'application/json' }) });
    // jsdom implements neither object-URL helper, so stub them on the URL global.
    createObjectURL = vi.fn().mockReturnValue('blob:fake');
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => clickSpy.mockRestore());

  it('fetches the program as a blob and triggers a download named by code', async () => {
    const { result } = renderHook(() => useExportProgramSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ programId: 'prog-1', code: 'ATLAS' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('/programs/prog-1/export/', { responseType: 'blob' });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('falls back to the program id as the filename when code is absent', async () => {
    const downloads: string[] = [];
    clickSpy.mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    const { result } = renderHook(() => useExportProgramSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ programId: 'prog-9' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(downloads).toEqual(['prog-9.json']);
  });
});

describe('useExportProjectSeed download flow (#967)', () => {
  let qc: QueryClient;
  let clickSpy: MockInstance<() => void>;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.clearAllMocks();
    getMock.mockResolvedValue({ data: new Blob(['{}'], { type: 'application/json' }) });
    createObjectURL = vi.fn().mockReturnValue('blob:fake');
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => clickSpy.mockRestore());

  it('fetches the project as a blob and triggers a download named by code', async () => {
    const { result } = renderHook(() => useExportProjectSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'proj-1', code: 'APOLLO' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('/projects/proj-1/export/', { responseType: 'blob' });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('falls back to the project id as the filename when code is absent', async () => {
    const downloads: string[] = [];
    clickSpy.mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    const { result } = renderHook(() => useExportProjectSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: 'proj-9' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(downloads).toEqual(['proj-9.json']);
  });

  it('rejects when projectId is missing without calling the API', async () => {
    const { result } = renderHook(() => useExportProjectSeed(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ projectId: undefined });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(getMock).not.toHaveBeenCalled();
  });
});
