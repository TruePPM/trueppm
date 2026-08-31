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
 * Views that honor a `?task=` drawer deep-link. Schedule and Grid read the param
 * directly; Board and Sprints go through `useUrlSelectedId('task')`. `today` is
 * deliberately absent — the Unified Today view has no task drawer, so a `?task=`
 * sent there would be silently dropped and the user would land on a surface with no
 * sign of the thing they clicked.
 */
const TASK_DRAWER_VIEWS: ReadonlySet<string> = new Set(['schedule', 'grid', 'board', 'sprints']);

/** Where a task deep-link goes when the lens's landing view has no task drawer. */
const TASK_DEEP_LINK_FALLBACK = 'schedule';

/**
 * The project view a task deep-link should open for `lens` — its landing view when
 * that view can show a task drawer, else Schedule.
 *
 * Entry was already personalized by the lens while every subsequent jump hardcoded
 * Schedule, so a Scrum Master clicking a notification about their own board story was
 * teleported onto the CPM Gantt (#2441). This keeps the deep-link on the surface the
 * user actually works in. The fallback matters for `unified`, whose landing view
 * (`today`) is not drawer-capable.
 */
export function lensTaskDeepLinkView(lens: RoleContext): string {
  const view = lensDefaultView(lens);
  return TASK_DRAWER_VIEWS.has(view) ? view : TASK_DEEP_LINK_FALLBACK;
}

/**
 * The full lens-aware `?task=` deep-link path for a task in a project. The single
 * place that composes a task deep-link, so the palette and the notification panel
 * cannot drift apart.
 */
export function taskDeepLinkPath(projectId: string, taskId: string, lens: RoleContext): string {
  return `/projects/${projectId}/${lensTaskDeepLinkView(lens)}?task=${taskId}`;
}

/**
 * Re-order each **verb** band's `visibleViews` so the lens-priority views lead, keeping
 * every other view in its original relative order (a stable promotion). Pure and
 * non-destructive: no view is added, removed, or moved between bands — only the
 * within-band order changes. `unified` (empty priority) returns the input order
 * unchanged, so it is a genuine no-op neutral default.
 *
 * `kind: 'scope'` bands are returned untouched (ADR-0942 §2). A scope band is not a
 * workflow — it is the project's own setup, not a lifecycle step — so there is no
 * workflow for a role lens to re-point, and its order is fixed for every lens.
 */
export function applyRoleContextLensOrder(
  groups: VisibleViewGroup[],
  lens: RoleContext,
): VisibleViewGroup[] {
  const priority = LENS_PRIORITY[lens] ?? [];
  if (priority.length === 0) return groups;

  const rank = new Map(priority.map((view, i) => [view, i]));
  return groups.map((group) => {
    if (group.kind !== 'verb') return group;
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
