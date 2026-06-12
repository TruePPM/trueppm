import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useMyFacets } from '@/hooks/useMyFacets';
import { ROLE_ADMIN } from '@/lib/roles';

/**
 * Render-gate for sprint scope-injection accept/reject affordances (ADR-0102 §3,
 * widened by ADR-0123 §3 / #1140).
 *
 * Returns `true` when the current user is Admin+ on the project **or** holds the
 * Scrum-Master or Product-Owner facet (ADR-0078). #1140 widened this off
 * ADMIN-only so the Product Owner — who owns sprint scope — and the Scrum Master,
 * who facilitates the ceremony, can accept/reject injections from the board even
 * when their access role is below Admin. This gates whether the accept tick,
 * reject menu item, and the ScopePendingReviewPanel controls are *rendered* — it
 * is NOT the security boundary. The server is the real gate: it enforces the same
 * `role-or-facet` rule AND a real ProjectMembership / TeamMembership on the task's
 * project, and returns `403 scope_accept_forbidden` regardless of role ordinal
 * (closing the ADR-0072 high-ordinal/Enterprise back-door). Treat any 403 from the
 * accept/reject endpoints as authoritative even if this hook returned `true`.
 *
 * Returns `false` while the role/project queries are loading so controls never
 * flash in for a user who turns out to lack permission.
 */
export function useCanManageScope(projectId: string | undefined): boolean {
  const { role } = useCurrentUserRole(projectId);
  const { isScrumMaster, isProductOwner } = useMyFacets(projectId);
  return (role !== null && role >= ROLE_ADMIN) || isScrumMaster || isProductOwner;
}
