/**
 * Role-context lens ordering (issue 1263, ADR-0162).
 *
 * Two pure helpers that consume the active `role_context` lens and re-point /
 * re-order *already-permitted* surfaces. Presentation only — neither helper
 * touches RBAC, the methodology filter, or the hidden-views set; both compose
 * strictly on top of whatever views the user is already allowed to see. The
 * `unified` lens is the identity (canonical order, default project view), so an
 * unconfigured user gets exactly today's behavior.
 *
 * Kept as a standalone module (not folded into `methodologyTabs.ts`) so the
 * canonical view registry is never edited — the lens is a layer over its output.
 */
import type { RoleContext } from '@/hooks/useCurrentUser';
import type { VisibleViewGroup } from '@/features/shell/methodologyTabs';

/**
 * The default project view each lens lands on at the project index
 * (`/projects/:id` → this view). These are universally-present routes (every
 * methodology has Today / Schedule / Board as reachable segments, ADR-0030/0180),
 * so the redirect always resolves. `unified` lands on the Unified Today view.
 */
export const LENS_DEFAULT_VIEW: Record<RoleContext, string> = {
  // The Unified Today split view (ADR-0180) is the dual-hat PM+SM home — the
  // purpose-built destination the `unified` lens lands on (was 'overview' in the
  // ADR-0162 v1 placeholder). `today` is visible for every methodology, so the
  // project-index redirect always resolves.
  unified: 'today',
  pm: 'schedule',
  scrum_master: 'board',
};

/**
 * Per-lens priority view keys, promoted to the front of *their own group*
 * (never moved across groups, never hidden). Order within the array is the
 * promoted order. `unified` is empty → identity transform.
 */
const LENS_PRIORITY: Record<RoleContext, readonly string[]> = {
  unified: [],
  // PM leads with the planning surfaces (Schedule then Grid).
  pm: ['schedule', 'grid'],
  // Scrum Master leads with the delivery surfaces (Board, then sprint planning).
  scrum_master: ['board', 'sprints', 'product-backlog'],
};

/** Resolve the project view a lens opens on (Overview for the neutral default). */
export function lensDefaultView(lens: RoleContext): string {
  return LENS_DEFAULT_VIEW[lens] ?? LENS_DEFAULT_VIEW.unified;
}

/**
 * Re-order each group's `visibleViews` so the lens-priority views lead, keeping
 * every other view in its original relative order (a stable promotion). Pure and
 * non-destructive: no view is added, removed, or moved between groups — only the
 * within-group order changes. `unified` (empty priority) returns the input order
 * unchanged, so it is a genuine no-op neutral default.
 */
export function applyRoleContextLensOrder(
  groups: VisibleViewGroup[],
  lens: RoleContext,
): VisibleViewGroup[] {
  const priority = LENS_PRIORITY[lens] ?? [];
  if (priority.length === 0) return groups;

  const rank = new Map(priority.map((view, i) => [view, i]));
  return groups.map((group) => {
    // Stable sort: promoted views first (by priority index), everything else
    // keeps its existing order. Non-priority views share rank +Infinity, so the
    // stable sort leaves their relative order untouched.
    const visibleViews = group.visibleViews
      .map((view, i) => ({ view, i }))
      .sort((a, b) => {
        const ra = rank.get(a.view) ?? Number.POSITIVE_INFINITY;
        const rb = rank.get(b.view) ?? Number.POSITIVE_INFINITY;
        return ra - rb || a.i - b.i;
      })
      .map((e) => e.view);
    return { ...group, visibleViews };
  });
}
