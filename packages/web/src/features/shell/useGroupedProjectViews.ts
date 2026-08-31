import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useProject } from '@/hooks/useProject';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import {
  groupedVisibleViewsForUser,
  surfaceHiddenViews,
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
  /** PLAN / DELIVER / TRACK verb bands and the WORKSPACE scope band, after the
   *  methodology + hidden-views + role filters and the role-context lens ordering.
   *  **Every** view is in here, `overview` and `settings` included — ADR-0942 retired
   *  the standalone leading/trailing views, so there is no second place to look. */
  groups: VisibleViewGroup[];
  /** Per-view display label; `sprints` adopts the configured iteration label. */
  labelFor: (view: string) => string;
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
 * (ADR-0193), apply the methodology preset + hidden-set filter, gate the WORKSPACE
 * band's two members (Team behind Scheduler+, Settings behind admin), drop emptied
 * bands, then apply the role-context lens ordering (ADR-0162, identity for the neutral
 * `unified` lens, and a no-op on the scope band). Route segments are unchanged
 * (rule 108): callers link to `/projects/:id/:view`.
 *
 * Args:
 *   projectId: The active project id, or null/undefined off a project route (the
 *     underlying queries stay disabled and the composition falls back to the
 *     HYBRID default so nothing flashes empty).
 *
 * Returns:
 *   The resolved `GroupedProjectViews` (methodology, banded views, `labelFor`).
 */
export function useGroupedProjectViews(projectId: string | null | undefined): GroupedProjectViews {
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

  // Role gates for the two WORKSPACE members (ADR-0942 §2 — the scope band can render
  // with both, either, or neither, so it needs the same empty-band drop every verb band
  // gets). Both gates were previously applied by the presentations themselves, which is
  // exactly the drift `useGroupedProjectViews` exists to prevent (#1642); they belong at
  // the single composition seam now that both views are band members.
  //
  //  - `resources` (Team): pessimistic — hidden while the role is loading (null) or below
  //    Scheduler. Direct URL access still works (PermissionDeniedNotice).
  //  - `settings`: strict `!== false` so the row stays visible while the role signal loads
  //    and never flash-hides for an admin (mirrors #2033). `/projects/:id/settings` no
  //    longer bounces a non-admin (#2971) — it renders a reduced member rail — so the gate
  //    survives on the narrower reason: this is persistent chrome and the member rail is
  //    currently ONE section, which a permanent nav entry would overstate. A member reaches
  //    it through the account menu, which links straight to the section's anchor.
  const roleAllows = (view: string) => {
    if (view === 'resources') return role !== null && role >= ROLE_SCHEDULER;
    if (view === 'settings') return user?.can_access_admin_settings !== false;
    return true;
  };

  // Role-context lens (ADR-0162): re-orders only already-permitted views within
  // their verb band; `unified` (default while `user` loads) is the identity → no flash.
  const groups = applyRoleContextLensOrder(
    groupedVisibleViewsForUser(methodology, hiddenViews)
      .map((g) => ({ ...g, visibleViews: g.visibleViews.filter(roleAllows) }))
      .filter((g) => g.visibleViews.length > 0),
    user?.role_context ?? 'unified',
  );

  // Per-view label: Sprints adopts the configured iteration label (ADR-0111/0116).
  const labelFor = (view: string) =>
    view === 'sprints' ? iteration.plural : (VIEW_TAB_META[view]?.label ?? view);

  return { methodology, groups, labelFor };
}
