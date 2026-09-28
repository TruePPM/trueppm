import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  useIsWorkspaceOwner,
  useWorkspaceOwnerStatus,
  WORKSPACE_OWNER_ROLE,
} from './useIsWorkspaceOwner';

const mockUser = vi.hoisted(() => ({
  value: {
    user: undefined as unknown,
    isLoading: false as boolean,
    isError: undefined as boolean | undefined,
    refetch: undefined as (() => void) | undefined,
  },
}));

vi.mock('./useCurrentUser', () => ({
  useCurrentUser: () => mockUser.value,
}));

function setUser(value: Partial<typeof mockUser.value>) {
  mockUser.value = {
    user: undefined,
    isLoading: false,
    isError: false,
    refetch: undefined,
    ...value,
  };
}

describe('useIsWorkspaceOwner', () => {
  it('returns null while the user signal is loading', () => {
    setUser({ isLoading: true });
    const { result } = renderHook(() => useIsWorkspaceOwner());
    expect(result.current).toBeNull();
  });

  it('returns null when the loaded payload omits workspace_role (stale /auth/me)', () => {
    // Conservative: an absent role must NOT read as "not owner" — a caller that
    // removes or disables on `false` would otherwise act on a non-answer. It
    // still fails closed overall because only `=== true` enables a control.
    setUser({ user: { id: '1' } });
    const { result } = renderHook(() => useIsWorkspaceOwner());
    expect(result.current).toBeNull();
  });

  it('returns false for a sub-owner workspace role (the #4210 plain-Admin profile)', () => {
    setUser({ user: { id: '1', workspace_role: WORKSPACE_OWNER_ROLE - 100 } }); // 300 = Admin
    const { result } = renderHook(() => useIsWorkspaceOwner());
    expect(result.current).toBe(false);
  });

  it('returns true at the OWNER threshold', () => {
    setUser({ user: { id: '1', workspace_role: WORKSPACE_OWNER_ROLE } });
    expect(renderHook(() => useIsWorkspaceOwner()).result.current).toBe(true);
  });
});

/**
 * #4210. The narrow hook collapses "loading" and "errored / no numeric role"
 * into one `null`, which is what let `WorkspaceDangerPage` render Owner-only
 * controls enabled to any Admin. These assert the widened form keeps the
 * situations apart, mirroring `useWorkspaceAdminStatus` (#3330).
 */
describe('useWorkspaceOwnerStatus', () => {
  it('reports loading while /auth/me is in flight', () => {
    setUser({ isLoading: true });
    expect(renderHook(() => useWorkspaceOwnerStatus()).result.current.verdict).toBe('loading');
  });

  it('reports unknown — not loading — once the read has failed', () => {
    setUser({ isError: true });
    expect(renderHook(() => useWorkspaceOwnerStatus()).result.current.verdict).toBe('unknown');
  });

  it('reports unknown when the payload carries no numeric workspace_role', () => {
    setUser({ user: { id: '1' } });
    expect(renderHook(() => useWorkspaceOwnerStatus()).result.current.verdict).toBe('unknown');
    // `workspace_role: null` is the deactivated-membership encoding — an answer
    // that still yields no ordinal to compare, so it is not a verdict either.
    setUser({ user: { id: '1', workspace_role: null } });
    expect(renderHook(() => useWorkspaceOwnerStatus()).result.current.verdict).toBe('unknown');
  });

  it('reports owner / not-owner either side of the OWNER threshold', () => {
    setUser({ user: { id: '1', workspace_role: WORKSPACE_OWNER_ROLE } });
    expect(renderHook(() => useWorkspaceOwnerStatus()).result.current.verdict).toBe('owner');
    setUser({ user: { id: '1', workspace_role: WORKSPACE_OWNER_ROLE - 1 } });
    expect(renderHook(() => useWorkspaceOwnerStatus()).result.current.verdict).toBe('not-owner');
  });

  it('is exactly the lossy projection the narrow hook reports, for every verdict', () => {
    const cases = [
      { user: { id: '1', workspace_role: WORKSPACE_OWNER_ROLE }, verdict: 'owner', narrow: true },
      { user: { id: '1', workspace_role: 300 }, verdict: 'not-owner', narrow: false },
      { isLoading: true, verdict: 'loading', narrow: null },
      { isError: true, verdict: 'unknown', narrow: null },
    ] as const;
    expect(new Set(cases.map((c) => c.verdict)).size).toBe(4);

    for (const c of cases) {
      setUser(c);
      expect(renderHook(() => useWorkspaceOwnerStatus()).result.current.verdict).toBe(c.verdict);
      expect(renderHook(() => useIsWorkspaceOwner()).result.current).toBe(c.narrow);
    }
  });

  it('passes the underlying refetch through, and degrades to a no-op when a mock omits it', () => {
    const refetch = vi.fn();
    setUser({ isError: true, refetch });
    renderHook(() => useWorkspaceOwnerStatus()).result.current.refetch();
    expect(refetch).toHaveBeenCalledTimes(1);

    setUser({ isError: true });
    expect(() =>
      renderHook(() => useWorkspaceOwnerStatus()).result.current.refetch(),
    ).not.toThrow();
  });
});
