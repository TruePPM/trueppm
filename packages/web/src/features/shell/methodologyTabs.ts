import type { Methodology } from '@/types';

/**
 * Tab visibility matrix per methodology preset (ADR-0041, amended by ADR-0053).
 *
 * Matrix:
 * | Tab             | WATERFALL | AGILE | HYBRID |
 * |-----------------|-----------|-------|--------|
 * | overview        | ✅        | ✅    | ✅     |
 * | today           | ✅        | ✅    | ✅     |
 * | board           | ✅        | ✅    | ✅     |
 * | product-backlog | ❌        | ✅    | ✅     |
 * | sprints         | ❌        | ✅    | ✅     |
 * | schedule        | ✅        | ❌    | ✅     |
 * | grid            | ✅        | ✅    | ✅     |
 * | calendar        | ✅        | ❌    | ✅     |
 * | resources       | ✅        | ✅    | ✅     |
 * | risk            | ✅        | ✅    | ✅     |
 * | reports         | ✅        | ✅    | ✅     |
 * | activity        | ✅        | ✅    | ✅     |
 *
 * `grid` replaces the legacy `wbs` + `list` entries (issue 334). Outline mode
 * inside Grid covers the WBS use case for WATERFALL and HYBRID; Flat mode is
 * the AGILE default (per `methodologyDefaultMode` in `features/grid/`).
 *
 * Tabs hidden by methodology are still reachable by direct URL — the preset
 * communicates "this is not how we work here", not "this is not allowed".
 */
const HIDDEN_FOR_METHODOLOGY: Record<Methodology, ReadonlySet<string>> = {
  WATERFALL: new Set(['sprints', 'product-backlog']),
  AGILE: new Set(['schedule', 'calendar']),
  HYBRID: new Set(),
};

export function isTabVisibleForMethodology(view: string, methodology: Methodology): boolean {
  return !HIDDEN_FOR_METHODOLOGY[methodology].has(view);
}

/**
 * v2 grouped view bar (ADR-0128 §A, amended by ADR-0195 and ADR-0203) — the grouping that
 * replaces the flat tab strip. Grouping is **visual only**: the route segments are unchanged
 * (rule 108 / ADR-0030) and the methodology filter above still owns visibility —
 * `groupedVisibleViews` simply applies it *within* each group.
 *
 * The layout is **methodology-adaptive** (ADR-0195, issue 1466): AGILE and HYBRID surface a
 * dedicated `DELIVER` group co-locating the daily sprint circuit
 * (Backlog → Sprints → Board) as one cognitive object; WATERFALL has no DELIVER group and
 * keeps `board` in TRACK (its kanban-tracking home) exactly as ADR-0128 shipped. `board`
 * is therefore the one view whose group depends on methodology — see `viewGroupsFor`.
 *
 * The group was named `SPRINT` in ADR-0195; ADR-0203 renamed it to **DELIVER** because the
 * iteration term is configurable (Sprint / Iteration / Cycle / PI, ADR-0111/0116) and lives
 * on the *view*, so a group literally labeled "Sprint" collides with the view inside it and
 * hard-codes agile jargon into a Hybrid workspace. "Deliver" is terminology-neutral and
 * verb-consistent with Plan / Track. The group *label* is always the fixed word "Deliver",
 * never the configurable iteration term (§12 invariant #5).
 *
 * `overview` (orientation landing) and `settings` (admin) stay **standalone** outside
 * the groups — see `STANDALONE_LEADING` / `STANDALONE_TRAILING`.
 */
export type ViewGroupId = 'PLAN' | 'DELIVER' | 'TRACK' | 'PEOPLE';

export interface ViewGroupDef {
  id: ViewGroupId;
  /** Spelled-out label used for the group's `aria-label` ("Plan views") and the
   *  visible mono header ("PLAN", uppercased at render). */
  label: string;
  /** Canonical view keys in display order (before the methodology filter). */
  views: readonly string[];
}

/** The leading standalone view (no group label) — the orientation landing (ADR-0030). */
export const STANDALONE_LEADING = 'overview';
/** The trailing standalone view (no group label) — project admin. */
export const STANDALONE_TRAILING = 'settings';

/** Methodologies that run a delivery cadence → surface the dedicated `DELIVER` group
 *  (ADR-0195; the group was named `SPRINT` before ADR-0203 renamed it). */
const DELIVER_METHODOLOGIES: ReadonlySet<Methodology> = new Set(['AGILE', 'HYBRID']);

/**
 * Ordered group → view assignment for a methodology (ADR-0195/ADR-0203, amends ADR-0128 §A).
 * The render order is PLAN · [DELIVER] · TRACK · PEOPLE; `board` lives in DELIVER for
 * cadence-running methodologies and in TRACK for WATERFALL. Every non-standalone view
 * must appear in exactly one group here for the current methodology, or it silently
 * never renders — the `groupedVisibleViews` invariant test guards this.
 */
function viewGroupsFor(methodology: Methodology): readonly ViewGroupDef[] {
  const hasDeliver = DELIVER_METHODOLOGIES.has(methodology);
  return [
    { id: 'PLAN', label: 'Plan', views: ['schedule', 'grid', 'calendar'] },
    // DELIVER — the co-located sprint circuit (ADR-0195, renamed from SPRINT in ADR-0203).
    // Only for AGILE/HYBRID; on WATERFALL the group is absent (Backlog/Sprints are hidden
    // and Board falls to TRACK), so no "Deliver" label ever appears on a schedule-first
    // project. The label is the fixed word "Deliver", never the configurable iteration term.
    ...(hasDeliver
      ? [
          {
            id: 'DELIVER' as const,
            label: 'Deliver',
            views: ['product-backlog', 'sprints', 'board'],
          },
        ]
      : []),
    // `today` leads TRACK — the Unified Today split view (ADR-0180). Visible for every
    // methodology (the board it embeds already is); it degrades gracefully with no active
    // sprint. On WATERFALL, `board` trails Today here as the kanban-tracking surface.
    {
      id: 'TRACK',
      label: 'Track',
      // `assets` (ADR-0215) trails TRACK — the unified reference-material surface
      // (task files + external links), visible for every methodology.
      views: hasDeliver
        ? ['today', 'risk', 'reports', 'activity', 'assets']
        : ['today', 'board', 'risk', 'reports', 'activity', 'assets'],
    },
    { id: 'PEOPLE', label: 'People', views: ['resources'] },
  ];
}

/**
 * Canonical superset group layout (the HYBRID shape — every group, every view, each view
 * once). Consumed by `HIDEABLE_VIEW_KEYS` and the Customize-views UI, which need the full
 * hideable set regardless of the active methodology. The *rendered* layout is
 * `groupedVisibleViews(methodology)`; this constant is the union template only.
 */
export const VIEW_GROUPS: readonly ViewGroupDef[] = viewGroupsFor('HYBRID');

export interface VisibleViewGroup extends ViewGroupDef {
  /** The group's views that survive the methodology filter, in order. */
  visibleViews: string[];
}

/**
 * Apply the methodology visibility matrix to the methodology-adaptive grouped layout.
 * Pure (no role gate — that stays in `ViewTabs`, as today) so it is trivially
 * unit-testable. Groups with no surviving views are dropped so the bar never renders an
 * empty group label (ADR-0128 §A / ADR-0195).
 */
export function groupedVisibleViews(methodology: Methodology): VisibleViewGroup[] {
  return viewGroupsFor(methodology)
    .map((g) => ({
      ...g,
      visibleViews: g.views.filter((v) => isTabVisibleForMethodology(v, methodology)),
    }))
    .filter((g) => g.visibleViews.length > 0);
}

/**
 * The set of view keys a user is permitted to hide (ADR-0139). Mirrors the
 * server-side `HIDEABLE_VIEW_KEYS` (profiles/constants.py) — keep the two in
 * sync. `overview` (`STANDALONE_LEADING`) and `settings` (`STANDALONE_TRAILING`)
 * are intentionally absent: Overview is the always-on landing (the structural
 * guarantee the nav can never be emptied) and Settings is an admin surface.
 */
export const HIDEABLE_VIEW_KEYS: ReadonlySet<string> = new Set(VIEW_GROUPS.flatMap((g) => g.views));

/**
 * Compose the per-user hidden-views preference (ADR-0139) on top of the
 * methodology filter, then apply the per-user Schedule-in-Deliver placement
 * opt-in (ADR-0203, #1645). Layering order: methodology preset (here, via
 * `groupedVisibleViews`) → personal hidden-set → Schedule-in-Deliver placement →
 * role gate (in `useGroupedProjectViews`).
 *
 * A view the methodology already hides never reaches the hidden filter, so a user
 * can only hide views that are visible for the current methodology. Groups left
 * empty by the personal filter are dropped (same as the methodology pass) so the
 * bar never renders an empty group label.
 *
 * `scheduleInDeliver` (opt-in, off by default) *additionally* echoes the Schedule
 * view into the DELIVER group so the plan sits next to the cadence. It is a
 * **placement addition, never a visibility change** (§12 invariant #5): it only
 * fires when Schedule is genuinely visible elsewhere (i.e. survives the
 * methodology + hidden filter — HYBRID in practice, since WATERFALL has no DELIVER
 * group and AGILE hides Schedule) and a DELIVER group exists. It therefore never
 * resurrects a methodology- or user-hidden view, and never invents a group. The
 * Schedule key is *appended* after the sprint circuit so Backlog → Sprints → Board
 * stays contiguous (Alex/Jordan's sprint-circuit guardrail). Schedule remains in
 * PLAN too — it now appears in both groups, routing to the same segment. Pure →
 * unit-testable.
 */
export function groupedVisibleViewsForUser(
  methodology: Methodology,
  hiddenViews: ReadonlySet<string>,
  scheduleInDeliver = false,
): VisibleViewGroup[] {
  const groups = groupedVisibleViews(methodology)
    .map((g) => ({ ...g, visibleViews: g.visibleViews.filter((v) => !hiddenViews.has(v)) }))
    .filter((g) => g.visibleViews.length > 0);

  if (!scheduleInDeliver) return groups;
  // Only echo Schedule into Deliver when it is genuinely visible elsewhere (Plan)
  // — never resurrect a hidden view, never invent a Deliver group.
  const scheduleVisible = groups.some((g) => g.visibleViews.includes('schedule'));
  if (!scheduleVisible) return groups;
  return groups.map((g) =>
    g.id === 'DELIVER' && !g.visibleViews.includes('schedule')
      ? { ...g, visibleViews: [...g.visibleViews, 'schedule'] }
      : g,
  );
}

/**
 * View keys hidden by the per-project leaf-surface toggles (ADR-0193, #956).
 * Only `reporting` maps to a view tab (`reports`); the other three surfaces
 * (time-tracking / baselines / monte-carlo) are in-view sub-surfaces gated at
 * their host components, so they contribute no tab-hide here. Callers union the
 * result into the same hidden-set they build from the per-user `hidden_views`
 * preference, so all three layers (methodology → per-user → per-project surface)
 * compose through the one `groupedVisibleViewsForUser` path.
 */
export function surfaceHiddenViews(visibility: { reporting: boolean }): string[] {
  return visibility.reporting ? [] : ['reports'];
}
