import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useAdminSettingsAccess } from './useAdminSettingsAccess';

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

describe('useAdminSettingsAccess', () => {
  it('reports `admin` when /auth/me positively answers true', () => {
    setUser({ user: { id: '1', can_access_admin_settings: true } });
    expect(renderHook(() => useAdminSettingsAccess()).result.current.verdict).toBe('admin');
  });

  it('reports `not-admin` when /auth/me positively answers false', () => {
    setUser({ user: { id: '1', can_access_admin_settings: false } });
    expect(renderHook(() => useAdminSettingsAccess()).result.current.verdict).toBe('not-admin');
  });

  it('reports `loading` while the read is in flight — never a verdict', () => {
    // isLoading wins even over a payload left in the cache: a stale user plus a
    // refetch in flight is still "no answer to this question yet".
    setUser({ isLoading: true, user: { id: '1', can_access_admin_settings: false } });
    expect(renderHook(() => useAdminSettingsAccess()).result.current.verdict).toBe('loading');
  });

  it('reports `unknown` when the /auth/me read failed', () => {
    setUser({ isError: true });
    expect(renderHook(() => useAdminSettingsAccess()).result.current.verdict).toBe('unknown');
  });

  it('reports `unknown` when the read resolved with no user at all', () => {
    setUser({ user: undefined });
    expect(renderHook(() => useAdminSettingsAccess()).result.current.verdict).toBe('unknown');
  });

  // The case the old guard admitted on, and the one `CurrentUser`'s required
  // `boolean` type cannot rule out: the declaration describes `MeSerializer`, not
  // the bytes that arrived. An older server — or a fixture that was never
  // representable — omits the field, and the verdict must be "no answer", never
  // "yes".
  it('reports `unknown` when the payload omits can_access_admin_settings (#3350)', () => {
    setUser({ user: { id: '1' } });
    expect(renderHook(() => useAdminSettingsAccess()).result.current.verdict).toBe('unknown');
  });

  it('reports `unknown` for a non-boolean can_access_admin_settings', () => {
    // A truthy non-boolean must not read as `admin`: the strict `typeof` test is
    // what keeps a malformed payload out, and a `!!` coercion would let it in.
    setUser({ user: { id: '1', can_access_admin_settings: 'true' } });
    expect(renderHook(() => useAdminSettingsAccess()).result.current.verdict).toBe('unknown');
  });

  it('passes the underlying refetch through as the escape from `unknown`', () => {
    const refetch = vi.fn();
    setUser({ isError: true, refetch });
    renderHook(() => useAdminSettingsAccess()).result.current.refetch();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('substitutes a no-op refetch when the hook is mocked without one', () => {
    setUser({ isError: true, refetch: undefined });
    const { result } = renderHook(() => useAdminSettingsAccess());
    expect(() => result.current.refetch()).not.toThrow();
  });
});
