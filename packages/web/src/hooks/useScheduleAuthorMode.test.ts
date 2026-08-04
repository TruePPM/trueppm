import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useScheduleAuthorMode } from './useScheduleAuthorMode';

vi.mock('./useCurrentUser', () => ({
  useCurrentUser: vi.fn(),
}));

import { useCurrentUser } from './useCurrentUser';

const useCurrentUserMock = vi.mocked(useCurrentUser);

function makeUser(id: string) {
  return {
    id,
    username: id,
    display_name: id,
    initials: id[0],
    email: `${id}@x`,
    max_project_role: 200,
    workspace_role: null,
    can_access_admin_settings: false,
    default_landing: 'auto' as const,
    landing: { intent: 'my_work' as const, path: '/me/work', resolved_by: 'fallback' as const },
    hidden_views: [],
    role_context: 'unified' as const,
    schedule_in_deliver: false,
    dnd_enabled: false,
    timezone: 'auto',
    date_format: 'auto' as const,
  };
}

describe('useScheduleAuthorMode (#2727, ADR-0776 §5)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('defaults to author mode when no stored preference', async () => {
    useCurrentUserMock.mockReturnValue({ user: makeUser('u1'), isLoading: false });
    const { result } = renderHook(() => useScheduleAuthorMode('p1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.mode).toBe('author');
  });

  it('respects a stored "read" preference', async () => {
    window.localStorage.setItem('trueppm.schedule.authorMode.u2.p1', 'read');
    useCurrentUserMock.mockReturnValue({ user: makeUser('u2'), isLoading: false });
    const { result } = renderHook(() => useScheduleAuthorMode('p1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.mode).toBe('read');
  });

  it('toggle() flips author <-> read and persists per-user per-project', async () => {
    useCurrentUserMock.mockReturnValue({ user: makeUser('u3'), isLoading: false });
    const { result } = renderHook(() => useScheduleAuthorMode('p9'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.toggle());
    expect(result.current.mode).toBe('read');
    expect(window.localStorage.getItem('trueppm.schedule.authorMode.u3.p9')).toBe('read');
    act(() => result.current.toggle());
    expect(result.current.mode).toBe('author');
    expect(window.localStorage.getItem('trueppm.schedule.authorMode.u3.p9')).toBe('author');
  });

  it('setMode() sets an explicit mode directly', async () => {
    useCurrentUserMock.mockReturnValue({ user: makeUser('u4'), isLoading: false });
    const { result } = renderHook(() => useScheduleAuthorMode('p1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.setMode('read'));
    expect(result.current.mode).toBe('read');
  });

  it('a stored preference is per-project — a different project does not inherit it', async () => {
    window.localStorage.setItem('trueppm.schedule.authorMode.u5.p1', 'read');
    useCurrentUserMock.mockReturnValue({ user: makeUser('u5'), isLoading: false });
    const { result } = renderHook(() => useScheduleAuthorMode('p2'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.mode).toBe('author');
  });

  it('reports isLoading until user resolves', () => {
    useCurrentUserMock.mockReturnValue({ user: undefined, isLoading: true });
    const { result } = renderHook(() => useScheduleAuthorMode('p1'));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.mode).toBe('author');
  });
});
