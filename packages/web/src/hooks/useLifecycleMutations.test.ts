import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useArchiveProject,
  useDeleteProject,
  useTransferProject,
  useUnarchiveProject,
} from './useProjectMutations';
import {
  useCloseProgram,
  useReopenProgram,
  useSplitProgram,
  useTransferSponsorship,
} from './useProgramMutations';

const postMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({
  apiClient: { post: postMock, delete: deleteMock, patch: vi.fn(), get: vi.fn() },
}));

function makeWrapper(qc: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe('Project lifecycle hooks (#530)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postMock.mockResolvedValue({ data: { id: 'proj-1', is_archived: true } });
    deleteMock.mockResolvedValue({});
  });

  it('useArchiveProject posts to /projects/:id/archive/', async () => {
    const { result } = renderHook(() => useArchiveProject('proj-1'), {
      wrapper: makeWrapper(makeClient()),
    });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/archive/');
  });

  it('useUnarchiveProject posts to /projects/:id/unarchive/', async () => {
    const { result } = renderHook(() => useUnarchiveProject('proj-1'), {
      wrapper: makeWrapper(makeClient()),
    });
    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/unarchive/');
  });

  it('useTransferProject posts the new owner id', async () => {
    const { result } = renderHook(() => useTransferProject('proj-1'), {
      wrapper: makeWrapper(makeClient()),
    });
    result.current.mutate({ new_owner_user_id: 'user-2' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/projects/proj-1/transfer/', {
      new_owner_user_id: 'user-2',
    });
  });

  it('useDeleteProject sends DELETE without force by default', async () => {
    const { result } = renderHook(() => useDeleteProject('proj-1'), {
      wrapper: makeWrapper(makeClient()),
    });
    result.current.mutate({});
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteMock).toHaveBeenCalledWith('/projects/proj-1/');
  });

  it('useDeleteProject appends ?force=true when force is set', async () => {
    const { result } = renderHook(() => useDeleteProject('proj-1'), {
      wrapper: makeWrapper(makeClient()),
    });
    result.current.mutate({ force: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteMock).toHaveBeenCalledWith('/projects/proj-1/?force=true');
  });
});

describe('Program lifecycle hooks (#530)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postMock.mockResolvedValue({ data: { id: 'prog-1', is_closed: true } });
  });

  it('useCloseProgram posts to /programs/:id/close/', async () => {
    const { result } = renderHook(() => useCloseProgram(), {
      wrapper: makeWrapper(makeClient()),
    });
    result.current.mutate('prog-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/programs/prog-1/close/');
  });

  it('useReopenProgram posts to /programs/:id/reopen/', async () => {
    const { result } = renderHook(() => useReopenProgram(), {
      wrapper: makeWrapper(makeClient()),
    });
    result.current.mutate('prog-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/programs/prog-1/reopen/');
  });

  it('useTransferSponsorship posts new_owner and optional new_lead', async () => {
    const { result } = renderHook(() => useTransferSponsorship(), {
      wrapper: makeWrapper(makeClient()),
    });
    result.current.mutate({
      programId: 'prog-1',
      new_owner_user_id: 'user-2',
      new_lead_user_id: 'user-3',
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/programs/prog-1/transfer-sponsorship/', {
      new_owner_user_id: 'user-2',
      new_lead_user_id: 'user-3',
    });
  });

  it('useTransferSponsorship omits new_lead when not provided', async () => {
    const { result } = renderHook(() => useTransferSponsorship(), {
      wrapper: makeWrapper(makeClient()),
    });
    result.current.mutate({ programId: 'prog-1', new_owner_user_id: 'user-2' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/programs/prog-1/transfer-sponsorship/', {
      new_owner_user_id: 'user-2',
    });
  });

  it('useSplitProgram posts splits payload to /split/', async () => {
    const { result } = renderHook(() => useSplitProgram(), {
      wrapper: makeWrapper(makeClient()),
    });
    result.current.mutate({
      programId: 'prog-1',
      splits: [{ name: 'A', project_ids: ['p1'] }],
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith('/programs/prog-1/split/', {
      splits: [{ name: 'A', project_ids: ['p1'] }],
    });
  });

  it('useSplitProgram surfaces the server {detail} verbatim on a 400', async () => {
    postMock.mockRejectedValueOnce({
      response: { data: { detail: 'Project p9 is not a project of this program.' } },
    });
    const { result } = renderHook(() => useSplitProgram(), {
      wrapper: makeWrapper(makeClient()),
    });
    result.current.mutate({ programId: 'prog-1', splits: [{ name: 'A', project_ids: ['p9'] }] });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Project p9 is not a project of this program.');
  });
});
