import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCanManageScope } from './useCanManageScope';
import { useCurrentUserRole } from './useCurrentUserRole';
import { ROLE_MEMBER, ROLE_SCHEDULER, ROLE_ADMIN, ROLE_OWNER } from '@/lib/roles';

vi.mock('./useCurrentUserRole', () => ({
  useCurrentUserRole: vi.fn(),
}));

const roleMock = vi.mocked(useCurrentUserRole);

describe('useCanManageScope (ADR-0102 §3 render-gate)', () => {
  beforeEach(() => roleMock.mockReset());

  it('hides controls for MEMBER (the contributor cannot self-accept)', () => {
    roleMock.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    const { result } = renderHook(() => useCanManageScope('p1'));
    expect(result.current).toBe(false);
  });

  it('hides controls for SCHEDULER (resource manager is not the team hat)', () => {
    roleMock.mockReturnValue({ role: ROLE_SCHEDULER, isLoading: false });
    const { result } = renderHook(() => useCanManageScope('p1'));
    expect(result.current).toBe(false);
  });

  it('shows controls for ADMIN and OWNER (the PM/Scrum-Master team hat)', () => {
    roleMock.mockReturnValue({ role: ROLE_ADMIN, isLoading: false });
    expect(renderHook(() => useCanManageScope('p1')).result.current).toBe(true);
    roleMock.mockReturnValue({ role: ROLE_OWNER, isLoading: false });
    expect(renderHook(() => useCanManageScope('p1')).result.current).toBe(true);
  });

  it('hides controls while the role is still loading (no flash-of-forbidden)', () => {
    roleMock.mockReturnValue({ role: null, isLoading: true });
    const { result } = renderHook(() => useCanManageScope('p1'));
    expect(result.current).toBe(false);
  });
});
