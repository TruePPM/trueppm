import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: {
    get: getMock,
  },
}));

import { useWorkspaceGroups } from './useWorkspaceGroups';

const RAW_GROUP = {
  id: 'grp-1',
  name: 'Avionics',
  description: 'Flight computer and firmware',
  lead: 'SR',
  lead_user_id: 'user-sr',
  member_count: 9,
  members: [{ id: 'u1', name: 'Sam Reyes', initials: 'SR', color: '#7C3AED' }],
  projects: [
    { id: 'proj-1', name: 'Orion', role: 100, role_label: 'Team Member' },
    { id: 'proj-2', name: 'Artemis IV', role: 300, role_label: 'Project Manager' },
  ],
};

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

describe('useWorkspaceGroups — snake→camel mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps member_count → memberCount and lead_user_id → leadUserId', async () => {
    // /workspace/groups/ returns the standard page-number envelope (#1355).
    getMock.mockResolvedValueOnce({
      data: { results: [RAW_GROUP], next: null },
    });

    const { result } = renderHook(() => useWorkspaceGroups(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [group] = result.current.data ?? [];
    expect(group.memberCount).toBe(9);
    expect(group.leadUserId).toBe('user-sr');
    expect(group.lead).toBe('SR');
    expect(group.projects).toEqual([
      { id: 'proj-1', name: 'Orion', role: 100, roleLabel: 'Team Member' },
      { id: 'proj-2', name: 'Artemis IV', role: 300, roleLabel: 'Project Manager' },
    ]);
    expect(group.members).toHaveLength(1);
  });

  it('calls GET /workspace/groups/', async () => {
    getMock.mockResolvedValueOnce({
      data: { results: [RAW_GROUP], next: null },
    });

    const { result } = renderHook(() => useWorkspaceGroups(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // fetchAllPages passes a params config on the first page (#1355).
    expect(getMock).toHaveBeenCalledWith('/workspace/groups/', { params: undefined });
  });
});
