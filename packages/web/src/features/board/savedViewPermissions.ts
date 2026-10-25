import { ROLE_MEMBER, ROLE_SCHEDULER } from '@/lib/roles';
import { isSameUser } from '@/lib/userId';

/**
 * Whether the viewer may write a project's shared saved board views, mirroring
 * the server gate (#4595): Member+ on the project, and — for an existing view —
 * the view's creator or Scheduler+. The server is still the enforcement point;
 * this only keeps a control from offering a write that can only 403.
 *
 * The role read has three states (`useCurrentUserRole`, #2961):
 * - loading (`role` null, no error): pessimistic, nothing is offered;
 * - failed (`role` null, `roleIsError`): UNSETTLED, never denial — Member is
 *   assumed so a transient blip does not strip a working control, at worst one
 *   refusal from the server;
 * - resolved: the ordinal decides.
 */
function effectiveRole(role: number | null | undefined, roleIsError: boolean): number | null {
  if (role != null) return role;
  return roleIsError ? ROLE_MEMBER : null;
}

/** May the viewer add a project-shared saved view? (Member+) */
export function canCreateSavedView(role: number | null | undefined, roleIsError = false): boolean {
  const r = effectiveRole(role, roleIsError);
  return r != null && r >= ROLE_MEMBER;
}

/**
 * May the viewer rename, repair or delete this saved view? Member+ AND
 * (creator OR Scheduler+). A view with no recorded creator is only editable by
 * a Scheduler+, because the server's creator check cannot match a null.
 */
export function canEditSavedView(
  role: number | null | undefined,
  roleIsError: boolean,
  createdBy: string | number | null | undefined,
  currentUserId: string | number | null | undefined,
): boolean {
  const r = effectiveRole(role, roleIsError);
  if (r == null || r < ROLE_MEMBER) return false;
  return r >= ROLE_SCHEDULER || isSameUser(createdBy, currentUserId);
}
