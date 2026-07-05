import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { getMock, postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: {
    get: getMock,
    post: postMock,
    patch: patchMock,
    delete: deleteMock,
  },
}));

import {
  useMentionGroups,
  useMentionGroupMutations,
} from './useMentionGroups';

const GROUP = {
  id: 'g1',
  server_version: 1,
  project: 'p1',
  name: 'subcontractors',
  description: 'site subs',
  email_default_on: false,
  members: [{ id: 'u1', username: 'alice', email: 'a@x.com' }],
  member_count: 1,
  muted_by_me: false,
};

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useMentionGroups', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches the project mention-groups list', async () => {
    getMock.mockResolvedValueOnce({ data: [GROUP] });
    const { result } = renderHook(() => useMentionGroups('p1'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/projects/p1/mention-groups/');
    expect(result.current.data?.[0].name).toBe('subcontractors');
  });

  it('does not fetch without a projectId', () => {
    renderHook(() => useMentionGroups(undefined), { wrapper: makeWrapper() });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('useMentionGroupMutations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create POSTs name + description', async () => {
    postMock.mockResolvedValueOnce({ data: GROUP });
    const { result } = renderHook(() => useMentionGroupMutations('p1'), {
      wrapper: makeWrapper(),
    });
    await act(async () => {
      await result.current.create.mutateAsync({ name: 'subs', description: 'x' });
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/mention-groups/', {
      name: 'subs',
      description: 'x',
    });
  });

  it('update PATCHes only the changed fields', async () => {
    patchMock.mockResolvedValueOnce({ data: GROUP });
    const { result } = renderHook(() => useMentionGroupMutations('p1'), {
      wrapper: makeWrapper(),
    });
    await act(async () => {
      await result.current.update.mutateAsync({ id: 'g1', email_default_on: true });
    });
    expect(patchMock).toHaveBeenCalledWith('/projects/p1/mention-groups/g1/', {
      email_default_on: true,
    });
  });

  it('addMember POSTs to the add-member action', async () => {
    postMock.mockResolvedValueOnce({ data: GROUP });
    const { result } = renderHook(() => useMentionGroupMutations('p1'), {
      wrapper: makeWrapper(),
    });
    await act(async () => {
      await result.current.addMember.mutateAsync({ id: 'g1', user: 'u2' });
    });
    expect(postMock).toHaveBeenCalledWith(
      '/projects/p1/mention-groups/g1/add-member/',
      { user: 'u2' },
    );
  });

  it('mute routes to mute/unmute by flag', async () => {
    postMock.mockResolvedValue({ data: GROUP });
    const { result } = renderHook(() => useMentionGroupMutations('p1'), {
      wrapper: makeWrapper(),
    });
    await act(async () => {
      await result.current.mute.mutateAsync({ id: 'g1', muted: true });
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/mention-groups/g1/mute/', {});
    await act(async () => {
      await result.current.mute.mutateAsync({ id: 'g1', muted: false });
    });
    expect(postMock).toHaveBeenCalledWith('/projects/p1/mention-groups/g1/unmute/', {});
  });

  it('remove DELETEs the group', async () => {
    deleteMock.mockResolvedValueOnce({});
    const { result } = renderHook(() => useMentionGroupMutations('p1'), {
      wrapper: makeWrapper(),
    });
    await act(async () => {
      await result.current.remove.mutateAsync('g1');
    });
    expect(deleteMock).toHaveBeenCalledWith('/projects/p1/mention-groups/g1/');
  });
});
