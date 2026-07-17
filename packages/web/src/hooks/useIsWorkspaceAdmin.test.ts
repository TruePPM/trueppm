import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useIsWorkspaceAdmin, WORKSPACE_ADMIN_ROLE } from './useIsWorkspaceAdmin';

const mockUser = vi.hoisted(() => ({
  value: { user: undefined as unknown, isLoading: false as boolean },
}));

vi.mock('./useCurrentUser', () => ({
  useCurrentUser: () => mockUser.value,
}));

describe('useIsWorkspaceAdmin', () => {
  it('returns null while the user signal is loading', () => {
    mockUser.value = { user: undefined, isLoading: true };
    const { result } = renderHook(() => useIsWorkspaceAdmin());
    expect(result.current).toBeNull();
  });

  it('returns null when the loaded payload omits workspace_role (stale /auth/me)', () => {
    // Conservative: an absent role must NOT read as "not admin" — the guard would
    // otherwise flash-redirect a real admin off a stale payload.
    mockUser.value = { user: { id: '1' }, isLoading: false };
    const { result } = renderHook(() => useIsWorkspaceAdmin());
    expect(result.current).toBeNull();
  });

  it('returns false for a sub-admin workspace role (the #2012 project-admin profile)', () => {
    mockUser.value = { user: { id: '1', workspace_role: WORKSPACE_ADMIN_ROLE - 200 }, isLoading: false };
    const { result } = renderHook(() => useIsWorkspaceAdmin());
    expect(result.current).toBe(false);
  });

  it('returns true at the ADMIN threshold and above (owner)', () => {
    mockUser.value = { user: { id: '1', workspace_role: WORKSPACE_ADMIN_ROLE }, isLoading: false };
    expect(renderHook(() => useIsWorkspaceAdmin()).result.current).toBe(true);
    mockUser.value = { user: { id: '1', workspace_role: 400 }, isLoading: false };
    expect(renderHook(() => useIsWorkspaceAdmin()).result.current).toBe(true);
  });
});
