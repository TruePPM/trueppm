import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useMyFacets } from '@/hooks/useMyFacets';
import { ROLE_ADMIN } from '@/lib/roles';

/**
 * Render-gate for inline-editing the Sprint Goal (#1095).
 *
 * `true` when the caller is Admin+ on the project **or** holds the Scrum-Master
 * facet (ADR-0078) — setting and refining the goal is the single most important
 * thing a Scrum Master does in Planning, so a SM who is correctly a Member /
 * Scheduler must not be locked out by the coarse role ladder.
 *
 * Deliberately distinct from {@link useCanManageScope} (ADR-0102 scope
 * accept/reject): goal-edit follows the *facilitator* (SM) facet, while
 * scope-accept is a separate authority — conflating them would wrongly grant a
 * Scrum Master the scope-accept tick. The server keeps the goal write at
 * Member+, so this hook is a UX affordance gate, not the security boundary.
 *
 * Returns `false` while the role query loads so the Edit control never flashes in.
 */
export function useCanEditSprintGoal(projectId: string | undefined): boolean {
  const { role } = useCurrentUserRole(projectId);
  const { isScrumMaster } = useMyFacets(projectId);
  return (role !== null && role >= ROLE_ADMIN) || isScrumMaster;
}
