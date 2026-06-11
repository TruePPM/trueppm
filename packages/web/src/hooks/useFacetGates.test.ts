import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCurrentUserRole } from './useCurrentUserRole';
import { useProject } from './useProject';
import { useCanEditSprintGoal } from './useCanEditSprintGoal';
import { useCanManageBacklog } from './useMyFacets';
import { ROLE_MEMBER, ROLE_ADMIN } from '@/lib/roles';

vi.mock('./useCurrentUserRole', () => ({ useCurrentUserRole: vi.fn() }));
vi.mock('./useProject', () => ({ useProject: vi.fn() }));

const roleMock = vi.mocked(useCurrentUserRole);
const projectMock = vi.mocked(useProject);

function withFacets(is_scrum_master: boolean, is_product_owner: boolean) {
  // Only my_facets is read by useMyFacets; the rest of the detail payload is irrelevant.
  projectMock.mockReturnValue({
    data: { my_facets: { is_scrum_master, is_product_owner } },
  } as unknown as ReturnType<typeof useProject>);
}

beforeEach(() => {
  roleMock.mockReset();
  projectMock.mockReset();
});

describe('useCanEditSprintGoal (#1095 — SM facet OR Admin+)', () => {
  it('grants a MEMBER who holds the Scrum-Master facet', () => {
    roleMock.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    withFacets(true, false);
    expect(renderHook(() => useCanEditSprintGoal('p1')).result.current).toBe(true);
  });

  it('grants ADMIN even without the facet', () => {
    roleMock.mockReturnValue({ role: ROLE_ADMIN, isLoading: false });
    withFacets(false, false);
    expect(renderHook(() => useCanEditSprintGoal('p1')).result.current).toBe(true);
  });

  it('denies a plain MEMBER with no facet (the inversion #1095 fixes)', () => {
    roleMock.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    withFacets(false, false);
    expect(renderHook(() => useCanEditSprintGoal('p1')).result.current).toBe(false);
  });

  it('does not grant goal-edit on the Product-Owner facet alone (SM facet drives it)', () => {
    roleMock.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    withFacets(false, true);
    expect(renderHook(() => useCanEditSprintGoal('p1')).result.current).toBe(false);
  });
});

describe('useCanManageBacklog (#1095 — PO facet OR Admin+)', () => {
  it('grants a MEMBER who holds the Product-Owner facet', () => {
    roleMock.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    withFacets(false, true);
    expect(renderHook(() => useCanManageBacklog('p1')).result.current).toBe(true);
  });

  it('grants ADMIN even without the facet', () => {
    roleMock.mockReturnValue({ role: ROLE_ADMIN, isLoading: false });
    withFacets(false, false);
    expect(renderHook(() => useCanManageBacklog('p1')).result.current).toBe(true);
  });

  it('denies a plain MEMBER with no facet', () => {
    roleMock.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    withFacets(false, false);
    expect(renderHook(() => useCanManageBacklog('p1')).result.current).toBe(false);
  });

  it('does not grant backlog manage on the Scrum-Master facet alone (PO facet drives it)', () => {
    roleMock.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    withFacets(true, false);
    expect(renderHook(() => useCanManageBacklog('p1')).result.current).toBe(false);
  });

  it('defaults both facets to false when my_facets is absent (loading / legacy payload)', () => {
    roleMock.mockReturnValue({ role: ROLE_MEMBER, isLoading: false });
    projectMock.mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useProject>);
    expect(renderHook(() => useCanManageBacklog('p1')).result.current).toBe(false);
  });
});
