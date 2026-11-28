import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ROLE_VIEWER, ROLE_MEMBER, ROLE_SCHEDULER, ROLE_ADMIN } from '@/lib/roles';
import { useCanRunMonteCarlo } from './useCanRunMonteCarlo';

const roleMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useCurrentUserRole', () => ({ useCurrentUserRole: roleMock }));

const settled = (role: number | null) => ({
  role,
  roleLabel: null,
  isLoading: false,
  isError: false,
});

describe('useCanRunMonteCarlo', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [ROLE_VIEWER, false],
    [ROLE_MEMBER, false],
    [ROLE_SCHEDULER, true],
    [ROLE_ADMIN, true],
  ])('role %s -> %s', (role, expected) => {
    roleMock.mockReturnValue(settled(role));
    expect(renderHook(() => useCanRunMonteCarlo('p1')).result.current).toBe(expected);
  });

  it('a settled non-member cannot run', () => {
    roleMock.mockReturnValue(settled(null));
    expect(renderHook(() => useCanRunMonteCarlo('p1')).result.current).toBe(false);
  });

  it('assumes rights while the role is loading or the lookup failed (rule 302)', () => {
    roleMock.mockReturnValue({ role: null, roleLabel: null, isLoading: true, isError: false });
    expect(renderHook(() => useCanRunMonteCarlo('p1')).result.current).toBe(true);
    roleMock.mockReturnValue({ role: null, roleLabel: null, isLoading: false, isError: true });
    expect(renderHook(() => useCanRunMonteCarlo('p1')).result.current).toBe(true);
  });
});
