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

import { useWorkspaceMembers } from './useWorkspaceMembers';

const RAW_MEMBER = {
  id: 'u1',
  name: 'Alice Khoury',
  initials: 'AK',
  color: '#1C6B3A',
  email: 'alice@example.com',
  role: 'Admin',
  role_value: 300,
  groups: ['Engineering'],
  project_count: 3,
  last_active: '2h ago',
  status: 'active' as const,
  sso: true,
  two_fa: false,
};

const RAW_INVITE = {
  id: 'inv-1',
  email: 'bob@example.com',
  role: 'Member',
  role_value: 100,
  status: 'pending',
  invited_by: 'AK',
  created_at: '2026-05-20T10:00:00Z',
  expires_at: '2026-06-20T10:00:00Z',
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

describe('useWorkspaceMembers — snake→camel mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps member two_fa → twoFa and project_count → projectCount', async () => {
    getMock
      .mockResolvedValueOnce({ data: [RAW_MEMBER] })  // /workspace/members/
      .mockResolvedValueOnce({ data: [] });            // /workspace/invites/

    const { result } = renderHook(() => useWorkspaceMembers(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const [member] = result.current.members;
    expect(member.twoFa).toBe(false);
    expect(member.sso).toBe(true);
    expect(member.projectCount).toBe(3);
    expect(member.roleValue).toBe(300);
    expect(member.lastActive).toBe('2h ago');
  });

  it('maps invite invited_by → sentBy and created_at → sentAt', async () => {
    getMock
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [RAW_INVITE] });

    const { result } = renderHook(() => useWorkspaceMembers(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const [invite] = result.current.pendingInvites;
    expect(invite.email).toBe('bob@example.com');
    expect(invite.sentBy).toBe('AK');
    expect(invite.sentAt).toBe('2026-05-20T10:00:00Z');
    expect(invite.id).toBe('inv-1');
  });

  it('returns empty arrays when both endpoints return empty lists', async () => {
    getMock
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });

    const { result } = renderHook(() => useWorkspaceMembers(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.members).toHaveLength(0);
    expect(result.current.pendingInvites).toHaveLength(0);
  });
});
