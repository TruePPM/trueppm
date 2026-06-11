import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useProject } from '@/hooks/useProject';
import { ROLE_ADMIN } from '@/lib/roles';

export interface MyFacets {
  isScrumMaster: boolean;
  isProductOwner: boolean;
}

/**
 * The caller's own Scrum-Master / Product-Owner team facets on a project
 * (ADR-0078 / #1095), read from the `my_facets` field on the project-detail
 * payload (`useProject`). Defaults to both-false while the project query is in
 * flight so a facet control never flashes in for a user who turns out to lack it.
 *
 * Facets are an axis *orthogonal* to the 5-role ladder — a plain Member can hold
 * the PO facet, an Admin may hold none. Render-gates resolve `role-or-facet`; the
 * server is the real boundary (it 403s regardless of the rendered control).
 */
export function useMyFacets(projectId: string | undefined): MyFacets {
  const project = useProject(projectId);
  const facets = project.data?.my_facets;
  return {
    isScrumMaster: facets?.is_scrum_master ?? false,
    isProductOwner: facets?.is_product_owner ?? false,
  };
}

/**
 * Render-gate for backlog *manage* controls — auto-rank, drag-reorder, and the
 * structural story fields the grooming drawer edits (type, epic, scoring inputs).
 *
 * `true` when the caller is Admin+ on the project **or** holds the Product-Owner
 * facet (ADR-0078 / ADR-0105 / #1095) — the PO owns backlog priority even when
 * their access role is below Admin, so the PM no longer outranks them on their
 * own backlog. Render-gate only; `IsProjectBacklogManager` enforces the same
 * `role-or-PO-facet` rule server-side.
 */
export function useCanManageBacklog(projectId: string | undefined): boolean {
  const { role } = useCurrentUserRole(projectId);
  const { isProductOwner } = useMyFacets(projectId);
  return (role !== null && role >= ROLE_ADMIN) || isProductOwner;
}
