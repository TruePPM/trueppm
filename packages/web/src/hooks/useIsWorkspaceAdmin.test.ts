import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  useIsWorkspaceAdmin,
  useWorkspaceAdminStatus,
  WORKSPACE_ADMIN_ROLE,
} from './useIsWorkspaceAdmin';

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

describe('useIsWorkspaceAdmin', () => {
  it('returns null while the user signal is loading', () => {
    setUser({ isLoading: true });
    const { result } = renderHook(() => useIsWorkspaceAdmin());
    expect(result.current).toBeNull();
  });

  it('returns null when the loaded payload omits workspace_role (stale /auth/me)', () => {
    // Conservative: an absent role must NOT read as "not admin" — a caller that
    // removes or redirects on `false` would otherwise act on a non-answer.
    setUser({ user: { id: '1' } });
    const { result } = renderHook(() => useIsWorkspaceAdmin());
    expect(result.current).toBeNull();
  });

  it('returns false for a sub-admin workspace role (the #2012 project-admin profile)', () => {
    setUser({ user: { id: '1', workspace_role: WORKSPACE_ADMIN_ROLE - 200 } });
    const { result } = renderHook(() => useIsWorkspaceAdmin());
    expect(result.current).toBe(false);
  });

  it('returns true at the ADMIN threshold and above (owner)', () => {
    setUser({ user: { id: '1', workspace_role: WORKSPACE_ADMIN_ROLE } });
    expect(renderHook(() => useIsWorkspaceAdmin()).result.current).toBe(true);
    setUser({ user: { id: '1', workspace_role: 400 } });
    expect(renderHook(() => useIsWorkspaceAdmin()).result.current).toBe(true);
  });
});

/**
 * #3330. The narrow hook collapses "loading" and "errored / no numeric role"
 * into one `null`, which is what let the route guard admit on a dead request.
 * These assert the widened form keeps them apart.
 */
describe('useWorkspaceAdminStatus', () => {
  it('reports loading while /auth/me is in flight', () => {
    setUser({ isLoading: true });
    expect(renderHook(() => useWorkspaceAdminStatus()).result.current.verdict).toBe('loading');
  });

  it('reports unknown — not loading — once the read has failed', () => {
    // `retry: false` on the query makes this terminal: `isLoading` is already
    // false and no further attempt will land on its own.
    setUser({ isError: true });
    expect(renderHook(() => useWorkspaceAdminStatus()).result.current.verdict).toBe('unknown');
  });

  it('reports unknown when the payload carries no numeric workspace_role', () => {
    setUser({ user: { id: '1' } });
    expect(renderHook(() => useWorkspaceAdminStatus()).result.current.verdict).toBe('unknown');
    // `workspace_role: null` is the deactivated-membership encoding — an answer
    // that still yields no ordinal to compare, so it is not a verdict either.
    setUser({ user: { id: '1', workspace_role: null } });
    expect(renderHook(() => useWorkspaceAdminStatus()).result.current.verdict).toBe('unknown');
  });

  it('reports admin / not-admin either side of the ADMIN threshold', () => {
    setUser({ user: { id: '1', workspace_role: WORKSPACE_ADMIN_ROLE } });
    expect(renderHook(() => useWorkspaceAdminStatus()).result.current.verdict).toBe('admin');
    setUser({ user: { id: '1', workspace_role: WORKSPACE_ADMIN_ROLE - 1 } });
    expect(renderHook(() => useWorkspaceAdminStatus()).result.current.verdict).toBe('not-admin');
  });

  /**
   * The relationship, not the values. `useIsWorkspaceAdmin` is now *derived* from
   * this hook, and six-plus callers still read the narrow form — so what keeps
   * them correct is not either hook's own behavior but the mapping between them.
   * Asserting it over every verdict means a fifth verdict, or a re-pointed
   * projection, fails here rather than silently at a call site.
   */
  it('is exactly the lossy projection the narrow hook reports, for every verdict', () => {
    const cases = [
      { user: { id: '1', workspace_role: WORKSPACE_ADMIN_ROLE }, verdict: 'admin', narrow: true },
      { user: { id: '1', workspace_role: 100 }, verdict: 'not-admin', narrow: false },
      { isLoading: true, verdict: 'loading', narrow: null },
      { isError: true, verdict: 'unknown', narrow: null },
    ] as const;
    // Non-zero denominator, and every member of the union is represented.
    expect(new Set(cases.map((c) => c.verdict)).size).toBe(4);

    for (const c of cases) {
      setUser(c);
      expect(renderHook(() => useWorkspaceAdminStatus()).result.current.verdict).toBe(c.verdict);
      expect(renderHook(() => useIsWorkspaceAdmin()).result.current).toBe(c.narrow);
    }
  });

  it('passes the underlying refetch through, and degrades to a no-op when a mock omits it', () => {
    const refetch = vi.fn();
    setUser({ isError: true, refetch });
    renderHook(() => useWorkspaceAdminStatus()).result.current.refetch();
    expect(refetch).toHaveBeenCalledTimes(1);

    // Optional at the type level so existing `useCurrentUser` mocks stay valid —
    // `undefined` must not become a third state or a crash on retry.
    setUser({ isError: true });
    expect(() =>
      renderHook(() => useWorkspaceAdminStatus()).result.current.refetch(),
    ).not.toThrow();
  });
});
