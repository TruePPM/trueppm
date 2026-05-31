import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_ADMIN } from '@/lib/roles';

/**
 * Render-gate for sprint scope-injection accept/reject affordances (ADR-0102 §3).
 *
 * Returns `true` only when the current user's role on the project is at least
 * ADMIN (the PM / Scrum-Master team hat). This gates whether the accept tick,
 * reject menu item, and the ScopePendingReviewPanel controls are *rendered* —
 * it is NOT the security boundary. The server is the real gate: it enforces
 * `role >= ADMIN` AND a real ProjectMembership on the task's project, and
 * returns `403 scope_accept_forbidden` regardless of role ordinal (closing the
 * ADR-0072 high-ordinal/Enterprise back-door). Treat any 403 from the
 * accept/reject endpoints as authoritative even if this hook returned `true`.
 *
 * Returns `false` while the role query is loading so controls never flash in
 * for a user who turns out to lack permission.
 */
export function useCanManageScope(projectId: string | undefined): boolean {
  const { role } = useCurrentUserRole(projectId);
  return role !== null && role >= ROLE_ADMIN;
}
