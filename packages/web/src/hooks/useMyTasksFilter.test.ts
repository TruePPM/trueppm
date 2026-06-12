import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMyTasksFilter } from './useMyTasksFilter';

vi.mock('./useCurrentUser', () => ({
  useCurrentUser: vi.fn(),
}));

vi.mock('./useCurrentUserRole', () => ({
  useCurrentUserRole: vi.fn(),
}));

import { useCurrentUser } from './useCurrentUser';
import { useCurrentUserRole } from './useCurrentUserRole';

const useCurrentUserMock = vi.mocked(useCurrentUser);
const useCurrentUserRoleMock = vi.mocked(useCurrentUserRole);

describe('useMyTasksFilter', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('defaults to on for MEMBER role when no stored preference', async () => {
    useCurrentUserMock.mockReturnValue({
      user: {
        id: 'u1',
        username: 'alice',
        display_name: 'A',
        initials: 'A',
        email: 'a@x',
        max_project_role: 100,
        workspace_role: null,
        can_access_admin_settings: false,
      },
      isLoading: false,
    });
    useCurrentUserRoleMock.mockReturnValue({ role: 100, isLoading: false });
    const { result } = renderHook(() => useMyTasksFilter('p1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(true);
  });

  it('defaults to off for SCHEDULER role (2) when no stored preference', async () => {
    useCurrentUserMock.mockReturnValue({
      user: {
        id: 'u2',
        username: 'pm',
        display_name: 'PM',
        initials: 'P',
        email: 'pm@x',
        max_project_role: 300,
        workspace_role: null,
        can_access_admin_settings: true,
      },
      isLoading: false,
    });
    useCurrentUserRoleMock.mockReturnValue({ role: 200, isLoading: false });
    const { result } = renderHook(() => useMyTasksFilter('p1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(false);
  });

  it('respects stored preference over role default', async () => {
    window.localStorage.setItem('trueppm.boardFilter.mine.u3.p1', '0');
    useCurrentUserMock.mockReturnValue({
      user: {
        id: 'u3',
        username: 'm',
        display_name: 'M',
        initials: 'M',
        email: 'm@x',
        max_project_role: 100,
        workspace_role: null,
        can_access_admin_settings: false,
      },
      isLoading: false,
    });
    useCurrentUserRoleMock.mockReturnValue({ role: 100, isLoading: false });
    const { result } = renderHook(() => useMyTasksFilter('p1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Stored '0' beats the MEMBER default of on.
    expect(result.current.enabled).toBe(false);
  });

  it('persists toggled state to localStorage per-user per-project', async () => {
    useCurrentUserMock.mockReturnValue({
      user: {
        id: 'u4',
        username: 'm',
        display_name: 'M',
        initials: 'M',
        email: 'm@x',
        max_project_role: 200,
        workspace_role: null,
        can_access_admin_settings: false,
      },
      isLoading: false,
    });
    useCurrentUserRoleMock.mockReturnValue({ role: 200, isLoading: false });
    const { result } = renderHook(() => useMyTasksFilter('p9'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.setEnabled(true));
    expect(result.current.enabled).toBe(true);
    expect(window.localStorage.getItem('trueppm.boardFilter.mine.u4.p9')).toBe('1');
    act(() => result.current.setEnabled(false));
    expect(window.localStorage.getItem('trueppm.boardFilter.mine.u4.p9')).toBe('0');
  });

  it('reports isLoading until role and user resolve', () => {
    useCurrentUserMock.mockReturnValue({ user: undefined, isLoading: true });
    useCurrentUserRoleMock.mockReturnValue({ role: null, isLoading: true });
    const { result } = renderHook(() => useMyTasksFilter('p1'));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.enabled).toBe(false);
  });
});
