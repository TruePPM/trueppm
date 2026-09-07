import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useCreateProject, useCalendars, useUpdateProject } from './useProjectMutations';

const postMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: { id: 'proj-new', name: 'New Project', description: '', start_date: '2026-05-01', calendar: null },
  }),
);
const patchMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: { id: 'proj-1', name: 'Updated Project', description: 'new desc', start_date: '2026-05-01', calendar: null },
  }),
);
const getMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: {
      count: 2,
      next: null,
      previous: null,
      results: [
        { id: 'cal-1', name: 'Standard' },
        { id: 'cal-2', name: 'Part-time' },
      ],
    },
  }),
);

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock, patch: patchMock, get: getMock },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useCreateProject', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('POSTs to /projects/ with the correct payload', async () => {
    const { result } = renderHook(() => useCreateProject(), { wrapper: makeWrapper(qc) });

    result.current.mutate({ name: 'New Project', start_date: '2026-05-01' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postMock).toHaveBeenCalledWith('/projects/', {
      name: 'New Project',
      start_date: '2026-05-01',
    });
  });

  it('returns the created project id on success', async () => {
    const { result } = renderHook(() => useCreateProject(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'New Project', start_date: '2026-05-01' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe('proj-new');
  });

  it('includes optional description when provided', async () => {
    const { result } = renderHook(() => useCreateProject(), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'New Project', start_date: '2026-05-01', description: 'A desc' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/', expect.objectContaining({ description: 'A desc' }));
  });
});

describe('useUpdateProject', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.clearAllMocks();
  });

  it('PATCHes to /projects/:id/ with the supplied fields', async () => {
    const { result } = renderHook(() => useUpdateProject('proj-1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'Updated Project', description: 'new desc' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(patchMock).toHaveBeenCalledWith('/projects/proj-1/', {
      name: 'Updated Project',
      description: 'new desc',
    });
  });

  it('rejects if projectId is null', async () => {
    const { result } = renderHook(() => useUpdateProject(null), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'X' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(patchMock).not.toHaveBeenCalled();
  });

  it('invalidates the project detail cache on success', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateProject('proj-1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ name: 'Updated Project' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project', 'proj-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });

  it('invalidates shellStats too, so the saver\'s own health chip follows the report', async () => {
    // #3501: `health` is one of the seven fields this PATCH carries, and the
    // shell chip's word is the server's `health_band` derived from it. The
    // socket echo covers other viewers; this covers the person who saved, whose
    // chip would otherwise hold the old word for the 30s staleTime.
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateProject('proj-1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ health: 'CRITICAL' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['shellStats', 'proj-1'] });
  });

  it("invalidates the project's notification preferences, whose zone the project timezone decides", async () => {
    // `Project.timezone` is an input to `quiet_hours_timezone`, which the server
    // computes on a DIFFERENT endpoint (#3377/#3397). Nothing optimistically
    // recomputes that chain and no event reports it, so without this the
    // editor's own Notifications page captions the quiet-hours window with the
    // pre-edit zone for the whole 30s staleTime — stating a WRONG zone, which
    // is worse than the omission the caption exists to fix (web-rule 331(d)).
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateProject('proj-1'), { wrapper: makeWrapper(qc) });
    result.current.mutate({ timezone: 'Asia/Tokyo' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['project-notification-preferences', 'proj-1'],
    });
  });

  it('does not invalidate a notification-preference cache for a null project', async () => {
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateProject(null), { wrapper: makeWrapper(qc) });
    result.current.mutate({ timezone: 'Asia/Tokyo' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ['project-notification-preferences', null],
    });
  });
});

describe('useCalendars', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.clearAllMocks();
  });

  it('fetches calendars from /calendars/', async () => {
    const { result } = renderHook(() => useCalendars(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/calendars/');
  });

  it('returns the calendars array from the paginated response', async () => {
    const { result } = renderHook(() => useCalendars(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data?.[0].name).toBe('Standard');
  });
});
