import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useProject } from '@/hooks/useProject';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import {
  groupedVisibleViewsForUser,
  surfaceHiddenViews,
  STANDALONE_LEADING,
  STANDALONE_TRAILING,
  type VisibleViewGroup,
} from '@/features/shell/methodologyTabs';
import { applyRoleContextLensOrder } from '@/features/shell/lensOrder';
import { VIEW_TAB_META } from '@/features/shell/viewMeta';
import { ROLE_SCHEDULER } from '@/lib/roles';
import type { Methodology } from '@/types';

/** The resolved project-view composition — every presentation of the project view
 *  model consumes this, so the bar and the rail can never drift (issue 1642). */
export interface GroupedProjectViews {
  /** Server-resolved effective methodology (`'HYBRID'` until the project loads). */
  methodology: Methodology;
  /** PLAN / DELIVER / TRACK / PEOPLE groups after the methodology + hidden-views +
   *  role filters and the role-context lens ordering. `overview` / `settings` are
   *  NOT in here — they are the standalone leading/trailing views below. */
  groups: VisibleViewGroup[];
  /** Per-view display label; `sprints` adopts the configured iteration label. */
  labelFor: (view: string) => string;
  /** The always-on leading standalone view (`overview`). */
  standaloneLeading: string;
  /** The trailing standalone view (`settings`). */
  standaloneTrailing: string;
}

/**
 * Resolve a project's methodology-adaptive view composition — the single source of
 * truth every project-view *presentation* consumes (the TopBar `ViewTabs` and the
 * left-rail "This project" tier, issue 1642). Extracting the composition into one
 * hook is the regression firewall: because both surfaces read the same output, a
 * view added to the model (e.g. `activity` per ADR-0201, `assets` per ADR-0215, or
 * any future key) appears in every presentation automatically and can never be
 * silently dropped from one of them.
 *
 * The composition (unchanged from the bar's prior inline logic): read the
 * SERVER-RESOLVED `effective_methodology` (rule 196 — never the raw override), union
 * the per-user `hidden_views` (ADR-0139) with the per-project surface hides
 * (ADR-0193), apply the methodology preset + hidden-set filter, gate the Team view
 * behind Scheduler+ (pessimistic while the role loads), drop emptied groups, then
 * apply the role-context lens ordering (ADR-0162, identity for the neutral
 * `unified` lens). Route segments are unchanged (rule 108): callers link to
 * `/projects/:id/:view`.
 *
 * Args:
 *   projectId: The active project id, or null/undefined off a project route (the
 *     underlying queries stay disabled and the composition falls back to the
 *     HYBRID default so nothing flashes empty).
 *
 * Returns:
 *   The resolved `GroupedProjectViews` (methodology, grouped views, `labelFor`,
 *   and the standalone leading/trailing view keys).
 */
export function useGroupedProjectViews(
  projectId: string | null | undefined,
): GroupedProjectViews {
  const { role } = useCurrentUserRole(projectId ?? undefined);
  const { user } = useCurrentUser();
  const project = useProject(projectId);
  const iteration = useIterationLabel(projectId);

  // Default to HYBRID (all tabs visible) until the project loads — read the
  // server-resolved preset (ADR-0107, rule 196), never the raw per-project override.
  const methodology = project.data?.effective_methodology ?? 'HYBRID';

  // Per-user nav visibility (ADR-0139) ∪ per-project leaf-surface hides (ADR-0193):
  // both compose into one hidden-set on top of the methodology filter.
  const hiddenViews = new Set([
    ...(user?.hidden_views ?? []),
    ...surfaceHiddenViews(project.data?.effective_surface_visibility ?? { reporting: true }),
  ]);

  // Role gate (pessimistic): the Team view is hidden while the role is loading
  // (null) or below Scheduler. Direct URL access still works (PermissionDeniedNotice).
  const roleAllows = (view: string) =>
    view !== 'resources' || (role !== null && role >= ROLE_SCHEDULER);

  // Role-context lens (ADR-0162): re-orders only already-permitted views within
  // their group; `unified` (default while `user` loads) is the identity → no flash.
  // Per-user Schedule-in-Deliver placement opt-in (ADR-0203, #1645): additively
  // echoes Schedule into the Deliver group. Off until `user` loads, so the calm
  // default never flashes the extra placement.
  const groups = applyRoleContextLensOrder(
    groupedVisibleViewsForUser(methodology, hiddenViews, user?.schedule_in_deliver ?? false)
      .map((g) => ({ ...g, visibleViews: g.visibleViews.filter(roleAllows) }))
      .filter((g) => g.visibleViews.length > 0),
    user?.role_context ?? 'unified',
  );

  // Per-view label: Sprints adopts the configured iteration label (ADR-0111/0116).
  const labelFor = (view: string) =>
    view === 'sprints' ? iteration.plural : (VIEW_TAB_META[view]?.label ?? view);

  return {
    methodology,
    groups,
    labelFor,
    standaloneLeading: STANDALONE_LEADING,
    standaloneTrailing: STANDALONE_TRAILING,
  };
}
