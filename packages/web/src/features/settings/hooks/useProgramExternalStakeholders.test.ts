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
  useProgramExternalStakeholders,
  useProgramExternalStakeholderMutations,
} from './useProgramExternalStakeholders';

const STAKEHOLDER = {
  id: 's1',
  name: 'Jane Client',
  email: 'jane@client.com',
  note: 'VP Sponsor',
  created_by: 'alice',
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useProgramExternalStakeholders', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches the program external stakeholder list', async () => {
    getMock.mockResolvedValueOnce({ data: [STAKEHOLDER] });
    const { result } = renderHook(() => useProgramExternalStakeholders('pr1'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith('/programs/pr1/external-stakeholders/');
    expect(result.current.data).toEqual([STAKEHOLDER]);
  });

  it('does not fetch when programId is undefined', () => {
    renderHook(() => useProgramExternalStakeholders(undefined), { wrapper: makeWrapper() });
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe('useProgramExternalStakeholderMutations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create POSTs the payload to the program-scoped endpoint', async () => {
    postMock.mockResolvedValueOnce({ data: STAKEHOLDER });
    const { result } = renderHook(() => useProgramExternalStakeholderMutations('pr1'), {
      wrapper: makeWrapper(),
    });
    await act(async () => {
      await result.current.create.mutateAsync({
        name: 'Jane Client',
        email: 'jane@client.com',
        note: 'VP Sponsor',
      });
    });
    expect(postMock).toHaveBeenCalledWith('/programs/pr1/external-stakeholders/', {
      name: 'Jane Client',
      email: 'jane@client.com',
      note: 'VP Sponsor',
    });
  });

  it('update PATCHes only the changed fields at the detail URL', async () => {
    patchMock.mockResolvedValueOnce({ data: { ...STAKEHOLDER, name: 'Renamed' } });
    const { result } = renderHook(() => useProgramExternalStakeholderMutations('pr1'), {
      wrapper: makeWrapper(),
    });
    await act(async () => {
      await result.current.update.mutateAsync({ id: 's1', name: 'Renamed' });
    });
    expect(patchMock).toHaveBeenCalledWith('/programs/pr1/external-stakeholders/s1/', {
      name: 'Renamed',
    });
  });

  it('remove DELETEs the detail URL', async () => {
    deleteMock.mockResolvedValueOnce({ data: null });
    const { result } = renderHook(() => useProgramExternalStakeholderMutations('pr1'), {
      wrapper: makeWrapper(),
    });
    await act(async () => {
      await result.current.remove.mutateAsync('s1');
    });
    expect(deleteMock).toHaveBeenCalledWith('/programs/pr1/external-stakeholders/s1/');
  });
});
