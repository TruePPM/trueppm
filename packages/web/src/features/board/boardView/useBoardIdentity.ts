/**
 * Who is looking at this board, and what may they do to it.
 *
 * Lifted out of `BoardView` for #2378. Two unrelated-looking things belong
 * together here: the project id in the three shapes callers want, and every
 * role-derived capability flag. They pair because each capability is a function
 * of the role fetched for that id, and scattering them meant six separate
 * guard clauses in the shell that all answered "may I?".
 */
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_ADMIN, ROLE_SCHEDULER, canEditTask } from '@/lib/roles';

export interface BoardIdentity {
  projectId: string;
  /**
   * `useProjectId()` yields `''` outside a project route. Nearly every hook
   * wants that absence as null/undefined rather than an empty string, so both
   * shapes are resolved once instead of re-branching at ~20 call sites.
   */
  projectIdOrNull: string | null;
  projectIdOrUndefined: string | undefined;
  currentRole: number | null;
  /**
   * Public board share (#1486): mint/manage is Admin+. The toolbar item is
   * hidden for lower roles and the dialog surfaces the server kill-switch 403
   * verbatim — the server stays authoritative.
   */
  canShareBoard: boolean;
  canConfigureBoard: boolean;
}

export function useBoardIdentity(rawProjectId: string | null | undefined) {
  const projectId = rawProjectId ?? '';
  const projectIdOrNull = projectId || null;
  const projectIdOrUndefined = projectId || undefined;
  const { role: currentRole } = useCurrentUserRole(projectIdOrUndefined);
  return {
    projectId,
    projectIdOrNull,
    projectIdOrUndefined,
    currentRole,
    canShareBoard: currentRole !== null && currentRole >= ROLE_ADMIN,
    canConfigureBoard: (currentRole ?? -1) >= ROLE_SCHEDULER,
  } satisfies BoardIdentity;
}

/**
 * Board authoring is Member+ (#2146): quick-capture, per-lane add, card drag,
 * and Move-to were all rendered for Viewers and then 403'd. Folds the role gate
 * into the board-wide flag every write affordance reads — pessimistic while the
 * role loads (`canEditTask(null)` is false). The server stays authoritative.
 *
 * `sprintStateUnknown` is pessimistic in the same way (#3424): a `?sprint=`
 * board whose sprints query has not resolved, or failed, locks exactly as a
 * closed sprint does, because the one thing the lock exists to prevent — a
 * card move back-dating scope into a COMPLETED sprint — is precisely what an
 * unresolved read cannot rule out. The two inputs are kept separate rather
 * than folded into `sprintClosed` so the closed-sprint banner (a disclosure)
 * stays silent until the sprint is *known* closed, while the lock (a withheld
 * affordance) engages the moment it is not known open.
 *
 * Kept out of `useBoardIdentity` for two reasons: the identity hook has to
 * resolve *before* the sprint scope that produces the sprint flags, and the
 * inputs stay deliberately separate concepts — the closed-sprint banner keys
 * off `sprintClosed` alone, so it must not appear on an active board merely
 * because the viewer lacks write access.
 */
export function boardReadOnly(
  currentRole: number | null,
  sprintClosed: boolean,
  sprintStateUnknown: boolean,
): boolean {
  return sprintClosed || sprintStateUnknown || !canEditTask(currentRole);
}
