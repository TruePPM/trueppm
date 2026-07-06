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
  useProgramMentionGroups,
  useProgramMentionGroupMutations,
} from './useProgramMentionGroups';

const GROUP = {
  id: 'g1',
  server_version: 1,
  program: 'pr1',
  name: 'tech-leads',
  description: 'leads',
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

describe('useProgramMentionGroups', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches the program mention-groups list', async () => {
    getMock.mockResolvedValueOnce({ data: [GROUP] });
    const { result } = renderHook(() => useProgramMentionGroups('pr1'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getMock).toHaveBeenCalledWith('/programs/pr1/mention-groups/');
    expect(result.current.data?.[0].name).toBe('tech-leads');
  });

  it('does not fetch without a programId', () => {
    renderHook(() => useProgramMentionGroups(undefined), { wrapper: makeWrapper() });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('useProgramMentionGroupMutations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create POSTs name + description', async () => {
    postMock.mockResolvedValueOnce({ data: GROUP });
    const { result } = renderHook(() => useProgramMentionGroupMutations('pr1'), {
      wrapper: makeWrapper(),
    });
    await act(async () => {
      await result.current.create.mutateAsync({ name: 'leads', description: 'x' });
    });
    expect(postMock).toHaveBeenCalledWith('/programs/pr1/mention-groups/', {
      name: 'leads',
      description: 'x',
    });
  });

  it('update PATCHes only the changed fields', async () => {
    patchMock.mockResolvedValueOnce({ data: GROUP });
    const { result } = renderHook(() => useProgramMentionGroupMutations('pr1'), {
      wrapper: makeWrapper(),
    });
    await act(async () => {
      await result.current.update.mutateAsync({ id: 'g1', email_default_on: true });
    });
    expect(patchMock).toHaveBeenCalledWith('/programs/pr1/mention-groups/g1/', {
      email_default_on: true,
    });
  });

  it('addMember POSTs to the add-member action', async () => {
    postMock.mockResolvedValueOnce({ data: GROUP });
    const { result } = renderHook(() => useProgramMentionGroupMutations('pr1'), {
      wrapper: makeWrapper(),
    });
    await act(async () => {
      await result.current.addMember.mutateAsync({ id: 'g1', user: 'u2' });
    });
    expect(postMock).toHaveBeenCalledWith(
      '/programs/pr1/mention-groups/g1/add-member/',
      { user: 'u2' },
    );
  });

  it('mute routes to mute/unmute by flag', async () => {
    postMock.mockResolvedValue({ data: GROUP });
    const { result } = renderHook(() => useProgramMentionGroupMutations('pr1'), {
      wrapper: makeWrapper(),
    });
    await act(async () => {
      await result.current.mute.mutateAsync({ id: 'g1', muted: true });
    });
    expect(postMock).toHaveBeenCalledWith('/programs/pr1/mention-groups/g1/mute/', {});
    await act(async () => {
      await result.current.mute.mutateAsync({ id: 'g1', muted: false });
    });
    expect(postMock).toHaveBeenCalledWith('/programs/pr1/mention-groups/g1/unmute/', {});
  });

  it('remove DELETEs the group', async () => {
    deleteMock.mockResolvedValueOnce({});
    const { result } = renderHook(() => useProgramMentionGroupMutations('pr1'), {
      wrapper: makeWrapper(),
    });
    await act(async () => {
      await result.current.remove.mutateAsync('g1');
    });
    expect(deleteMock).toHaveBeenCalledWith('/programs/pr1/mention-groups/g1/');
  });
});
