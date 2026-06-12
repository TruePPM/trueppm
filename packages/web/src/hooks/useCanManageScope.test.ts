import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCanManageScope } from './useCanManageScope';
import { useCurrentUserRole } from './useCurrentUserRole';
import { useMyFacets } from './useMyFacets';
import { ROLE_MEMBER, ROLE_SCHEDULER, ROLE_ADMIN, ROLE_OWNER } from '@/lib/roles';

vi.mock('./useCurrentUserRole', () => ({
  useCurrentUserRole: vi.fn(),
}));
vi.mock('./useMyFacets', () => ({
  useMyFacets: vi.fn(),
}));

const roleMock = vi.mocked(useCurrentUserRole);
const facetsMock = vi.mocked(useMyFacets);

const NO_FACETS = { isScrumMaster: false, isProductOwner: false };

describe('useCanManageScope (ADR-0102 §3 / ADR-0123 §3 render-gate)', () => {
  beforeEach(() => {
    roleMock.mockReset();
    facetsMock.mockReset();
    facetsMock.mockReturnValue(NO_FACETS);
  });

  it('hides controls for a MEMBER with no facet (the contributor cannot self-accept)', () => {
    roleMock.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    const { result } = renderHook(() => useCanManageScope('p1'));
    expect(result.current).toBe(false);
  });

  it('hides controls for a SCHEDULER with no facet (resource manager is not the team hat)', () => {
    roleMock.mockReturnValue({ role: ROLE_SCHEDULER, isLoading: false });
    const { result } = renderHook(() => useCanManageScope('p1'));
    expect(result.current).toBe(false);
  });

  it('shows controls for ADMIN and OWNER (the PM team hat)', () => {
    roleMock.mockReturnValue({ role: ROLE_ADMIN, isLoading: false });
    expect(renderHook(() => useCanManageScope('p1')).result.current).toBe(true);
    roleMock.mockReturnValue({ role: ROLE_OWNER, isLoading: false });
    expect(renderHook(() => useCanManageScope('p1')).result.current).toBe(true);
  });

  it('shows controls for a Member holding the Product-Owner facet (#1140 — PO owns scope)', () => {
    roleMock.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    facetsMock.mockReturnValue({ isScrumMaster: false, isProductOwner: true });
    const { result } = renderHook(() => useCanManageScope('p1'));
    expect(result.current).toBe(true);
  });

  it('shows controls for a Member holding the Scrum-Master facet (#1140 — SM facilitates)', () => {
    roleMock.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    facetsMock.mockReturnValue({ isScrumMaster: true, isProductOwner: false });
    const { result } = renderHook(() => useCanManageScope('p1'));
    expect(result.current).toBe(true);
  });

  it('hides controls while the role is still loading and no facet (no flash-of-forbidden)', () => {
    roleMock.mockReturnValue({ role: null, isLoading: true });
    const { result } = renderHook(() => useCanManageScope('p1'));
    expect(result.current).toBe(false);
  });

  it('shows controls when the facet resolves before the role finishes loading', () => {
    // The facet is sufficient on its own — a PO/SM whose role query is still in
    // flight should not have the controls suppressed once their facet is known.
    roleMock.mockReturnValue({ role: null, isLoading: true });
    facetsMock.mockReturnValue({ isScrumMaster: false, isProductOwner: true });
    const { result } = renderHook(() => useCanManageScope('p1'));
    expect(result.current).toBe(true);
  });
});
