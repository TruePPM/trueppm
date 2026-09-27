import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  useAddGroupMember,
  useCreateGroup,
  useDeleteGroup,
  useGrantGroupProject,
  useRemoveGroupMember,
  useRevokeGroupProject,
  useUpdateGroup,
} from './useWorkspaceGroupMutations';

const postMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({
  apiClient: { post: postMock, patch: patchMock, delete: deleteMock },
}));

let qc: QueryClient;
let invalidate: ReturnType<typeof vi.spyOn>;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  [postMock, patchMock, deleteMock].forEach((m) => m.mockReset());
  postMock.mockResolvedValue({ data: { id: 'g1' } });
  patchMock.mockResolvedValue({ data: { id: 'g1' } });
  deleteMock.mockResolvedValue({});
  qc = new QueryClient();
  invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
});

const GROUPS_KEY = { queryKey: ['workspace-groups'] };

describe('workspace group mutations', () => {
  it('create posts the payload and refreshes the groups list', async () => {
    const { result } = renderHook(() => useCreateGroup(), { wrapper });
    let data: unknown;
    await act(async () => {
      data = await result.current.mutateAsync({
        name: 'Platform',
        description: 'infra',
        lead: 'u1',
      });
    });
    expect(postMock).toHaveBeenCalledWith('/workspace/groups/', {
      name: 'Platform',
      description: 'infra',
      lead: 'u1',
    });
    expect(data).toEqual({ id: 'g1' });
    expect(invalidate).toHaveBeenCalledWith(GROUPS_KEY);
  });

  it('update patches the group by id with the remaining fields only', async () => {
    const { result } = renderHook(() => useUpdateGroup(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'g1', name: 'Platform Eng', lead: null });
    });
    expect(patchMock).toHaveBeenCalledWith('/workspace/groups/g1/', {
      name: 'Platform Eng',
      lead: null,
    });
    expect(invalidate).toHaveBeenCalledWith(GROUPS_KEY);
  });

  it('delete removes the group', async () => {
    const { result } = renderHook(() => useDeleteGroup(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('g1');
    });
    expect(deleteMock).toHaveBeenCalledWith('/workspace/groups/g1/');
    expect(invalidate).toHaveBeenCalledWith(GROUPS_KEY);
  });

  it('adds and removes members through the nested members collection', async () => {
    const add = renderHook(() => useAddGroupMember(), { wrapper });
    const remove = renderHook(() => useRemoveGroupMember(), { wrapper });
    await act(async () => {
      await add.result.current.mutateAsync({ groupId: 'g1', userId: '42' });
      await remove.result.current.mutateAsync({ groupId: 'g1', userId: '42' });
    });
    expect(postMock).toHaveBeenCalledWith('/workspace/groups/g1/members/', { user: '42' });
    expect(deleteMock).toHaveBeenCalledWith('/workspace/groups/g1/members/42/');
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('grants and revokes project access at a conferred role', async () => {
    const grant = renderHook(() => useGrantGroupProject(), { wrapper });
    const revoke = renderHook(() => useRevokeGroupProject(), { wrapper });
    await act(async () => {
      await grant.result.current.mutateAsync({ groupId: 'g1', projectId: 'p1', role: 3 });
      await revoke.result.current.mutateAsync({ groupId: 'g1', projectId: 'p1' });
    });
    expect(postMock).toHaveBeenCalledWith('/workspace/groups/g1/projects/', {
      project: 'p1',
      role: 3,
    });
    expect(deleteMock).toHaveBeenCalledWith('/workspace/groups/g1/projects/p1/');
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
