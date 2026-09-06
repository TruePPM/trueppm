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
 * | assets          | ✅        | ✅    | ✅     |
 * | settings        | ✅        | ✅    | ✅     |
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
 * The view keys a methodology hides from the nav, in matrix order.
 *
 * Exported so the pre-save flip warning (#3294) can *name* the views it is
 * about to hide from this one matrix instead of re-listing them in prose. The
 * warning that shipped with #2619 hard-coded "sprints" in its copy while the
 * matrix already hid `product-backlog` alongside it, and said nothing at all
 * about the two views AGILE hides — a second list of the same fact, drifted.
 */
export function hiddenViewsForMethodology(methodology: Methodology): string[] {
  return [...HIDDEN_FOR_METHODOLOGY[methodology]];
}

/**
 * The project rail's view taxonomy (ADR-0942, superseding ADR-0128 §A's `PEOPLE`
 * group and its standalone leading/trailing views). Grouping is **visual only**:
 * the route segments are unchanged (rule 108 / ADR-0030) and the methodology filter
 * above still owns visibility — `groupedVisibleViews` simply applies it *within*
 * each band.
 *
 * Three **verb** bands in lifecycle order plus one **scope** band:
 *
 * ```
 * PLAN       schedule · grid · calendar
 * DELIVER    product-backlog · sprints · board            (AGILE/HYBRID only)
 * TRACK      overview · today · risk · reports · activity · assets   (+ board on WATERFALL)
 * ─────────────────────────────────────────────────────── full-bleed rule
 * WORKSPACE  resources · settings                          pinned, raised
 * ```
 *
 * **Every view is a band member** — `STANDALONE_LEADING` / `STANDALONE_TRAILING` are
 * retired concepts. `overview` leads TRACK because the landing route leads its own band
 * and "Overview" named a *position* that is no longer true (ADR-0942 §7/§8); `today`
 * follows it as the head of the tracking sequence proper (ADR-0180, amended).
 *
 * The layout stays **methodology-adaptive** (ADR-0195 §A′, retained in full): AGILE and
 * HYBRID surface a dedicated `DELIVER` band co-locating the daily sprint circuit
 * (Backlog → Sprints → Board) as one cognitive object; WATERFALL has no DELIVER band and
 * keeps `board` in TRACK (its kanban-tracking home). `board` is therefore the one view
 * whose band depends on methodology — see `viewGroupsFor`. That is not a violation of the
 * one-home rule: `board` is in exactly one band for any given project, and the rule
 * forbids two bands *in one render*.
 *
 * `calendar` deliberately stays in PLAN. `HIDDEN_FOR_METHODOLOGY` hides only `sprints`
 * and `product-backlog` on WATERFALL, so `calendar` is visible there — and WATERFALL has
 * no DELIVER band, so moving `calendar` into DELIVER would delete it from the WATERFALL
 * rail outright (ADR-0942 §4).
 *
 * The DELIVER band's *label* is always the fixed word "Deliver", never the configurable
 * iteration term (ADR-0203 §12 invariant #5) — a band literally labeled "Sprint" would
 * collide with the view inside it and hard-code agile jargon into a Hybrid workspace.
 */
export type ViewGroupId = 'PLAN' | 'DELIVER' | 'TRACK' | 'WORKSPACE';

/**
 * What kind of container a band is. Deliberately about the container rather than the
 * contents (ADR-0942 §2):
 *
 * - `verb` — a labelled group inside the rail's scrolling flow.
 * - `scope` — a container the rail's flow *ends at*: a full-bleed rule, a raised ground,
 *   and items pinned out of the scrolling sequence.
 *
 * Everything else about the two is identical **on purpose** — type, weight, color, height,
 * icon, active state. The distinction is never carried by contrast, size, weight or
 * opacity: each of those reads as "less important" in DS v1.0 and three of them read as
 * "unavailable". WORKSPACE is not less important (a self-hoster lives in Settings in week
 * one), it is *elsewhere* — so the rail says elsewhere by changing the floor, not by
 * fading the furniture.
 */
export type ViewGroupKind = 'verb' | 'scope';

export interface ViewGroupDef {
  id: ViewGroupId;
  kind: ViewGroupKind;
  /** Spelled-out label used for the band's `aria-label` ("Plan views") and the
   *  visible mono header ("PLAN", uppercased at render). */
  label: string;
  /** Canonical view keys in display order (before the methodology filter). */
  views: readonly string[];
}

/** Methodologies that run a delivery cadence → surface the dedicated `DELIVER` band
 *  (ADR-0195; the band was named `SPRINT` before ADR-0203 renamed it). */
const DELIVER_METHODOLOGIES: ReadonlySet<Methodology> = new Set(['AGILE', 'HYBRID']);

/**
 * Ordered band → view assignment for a methodology (ADR-0942, amending ADR-0195/0203 and
 * superseding ADR-0128 §A). The render order is PLAN · [DELIVER] · TRACK · WORKSPACE;
 * `board` lives in DELIVER for cadence-running methodologies and in TRACK for WATERFALL.
 * Every view must appear in exactly one band here for the current methodology, or it
 * silently never renders — the `groupedVisibleViews` invariant test guards this.
 */
function viewGroupsFor(methodology: Methodology): readonly ViewGroupDef[] {
  const hasDeliver = DELIVER_METHODOLOGIES.has(methodology);
  return [
    { id: 'PLAN', kind: 'verb', label: 'Plan', views: ['schedule', 'grid', 'calendar'] },
    // DELIVER — the co-located sprint circuit (ADR-0195, renamed from SPRINT in ADR-0203).
    // Only for AGILE/HYBRID; on WATERFALL the band is absent (Backlog/Sprints are hidden
    // and Board falls to TRACK), so no "Deliver" label ever appears on a schedule-first
    // project. The label is the fixed word "Deliver", never the configurable iteration term.
    ...(hasDeliver
      ? [
          {
            id: 'DELIVER' as const,
            kind: 'verb' as const,
            label: 'Deliver',
            views: ['product-backlog', 'sprints', 'board'],
          },
        ]
      : []),
    // `overview` leads TRACK — the landing route leads its own band (ADR-0942 §8), which
    // also makes the desktop head order match mobile's, where ADR-0196 already fixes
    // `overview` first and `today` second (the #1324 guarantee). `today` (ADR-0180) is the
    // head of the tracking sequence proper; it is visible for every methodology (the board
    // it embeds already is) and degrades gracefully with no active sprint. On WATERFALL,
    // `board` trails Today here as the kanban-tracking surface.
    {
      id: 'TRACK',
      kind: 'verb',
      label: 'Track',
      // `assets` (ADR-0215) trails TRACK — the unified reference-material surface
      // (task files + external links), visible for every methodology.
      views: hasDeliver
        ? ['overview', 'today', 'risk', 'reports', 'activity', 'assets']
        : ['overview', 'today', 'board', 'risk', 'reports', 'activity', 'assets'],
    },
    // WORKSPACE — the scope band (ADR-0942 §2/§5). Team and Settings answer the same kind
    // of question ("who and how is this project set up") rather than naming a lifecycle
    // step, which is why they sit together and outside the verb sequence. Both members are
    // independently gated — `resources` behind Scheduler+, `settings` behind admin — so the
    // band can render with both, either, or neither member; the empty-band rule below drops
    // it entirely when nothing survives, rule and raised ground included.
    { id: 'WORKSPACE', kind: 'scope', label: 'Workspace', views: ['resources', 'settings'] },
  ];
}

/**
 * Canonical superset band layout (the HYBRID shape — every band, every view, each view
 * once). Consumed by the Customize-views UI, which needs the full view vocabulary
 * regardless of the active methodology. The *rendered* layout is
 * `groupedVisibleViews(methodology)`; this constant is the union template only.
 *
 * Note it is deliberately **not** the source of `HIDEABLE_VIEW_KEYS` any more — see below.
 */
export const VIEW_GROUPS: readonly ViewGroupDef[] = viewGroupsFor('HYBRID');

export interface VisibleViewGroup extends ViewGroupDef {
  /** The band's views that survive the methodology filter, in order. */
  visibleViews: string[];
}

/**
 * Apply the methodology visibility matrix to the methodology-adaptive band layout.
 * Pure (no role gate — that stays in `useGroupedProjectViews`) so it is trivially
 * unit-testable. Bands with no surviving views are dropped so the rail never renders an
 * empty band label — and, for the scope band, no rule and no raised ground either
 * (ADR-0128 §A's empty-band rule, applied unchanged by ADR-0942 §2).
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
 * The set of view keys a user is permitted to hide (ADR-0139).
 *
 * This is an **authored literal**, not a derivation (ADR-0942 §6). It used to be
 * `new Set(VIEW_GROUPS.flatMap((g) => g.views))` — hideability fell out of band
 * membership, and `overview` / `settings` were unhideable purely because they stood
 * outside every band. ADR-0942 puts both *inside* bands, so under the old derivation they
 * would have silently become user-hideable: the web vocabulary would diverge from the
 * server's frozen one, the server would reject the resulting write with a 400, and the
 * ADR-0030/0139 guarantee that a user's nav can never be emptied would be gone.
 *
 * Band membership and hideability are therefore decoupled. Three invariants hold, and are
 * asserted by `methodologyTabs.test.ts` rather than by this comment:
 *   1. this set and {@link ALWAYS_ON_VIEW_KEYS} are disjoint;
 *   2. every band member is in exactly one of them — so a view added to a band can neither
 *      silently become hideable nor silently become un-customizable;
 *   3. this set equals the server's `apps/profiles/constants.py` set, via the shared
 *      `contracts/hideable-views.json` contract that a pytest asserts against too.
 */
export const HIDEABLE_VIEW_KEYS: ReadonlySet<string> = new Set([
  // PLAN
  'schedule',
  'grid',
  'calendar',
  // DELIVER (AGILE/HYBRID) — Backlog · Sprints · Board (ADR-0195)
  'product-backlog',
  'sprints',
  'board',
  // TRACK
  'today',
  'risk',
  'reports',
  'activity',
  'assets',
  // WORKSPACE
  'resources',
]);

/**
 * The authored complement of {@link HIDEABLE_VIEW_KEYS} — band members a user may never
 * hide (ADR-0942 §6). `overview` is the always-on landing (ADR-0030): keeping it
 * unhideable is what guarantees a user's nav can never be emptied. `settings` is an admin
 * surface, not a hideable workflow view.
 *
 * These are *not* absent from the server's vocabulary by accident — the server rejects
 * either key in `hidden_views` with a 400 (`apps/profiles/constants.py`).
 */
export const ALWAYS_ON_VIEW_KEYS: ReadonlySet<string> = new Set(['overview', 'settings']);

/**
 * Compose the per-user hidden-views preference (ADR-0139) on top of the methodology
 * filter. Layering order: methodology preset (here, via `groupedVisibleViews`) → personal
 * hidden-set → role gate (in `useGroupedProjectViews`).
 *
 * A view the methodology already hides never reaches the hidden filter, so a user can only
 * hide views that are visible for the current methodology. Bands left empty by the
 * personal filter are dropped (same as the methodology pass) so the rail never renders an
 * empty band label.
 *
 * {@link ALWAYS_ON_VIEW_KEYS} survive the hidden-set unconditionally. The server already
 * rejects those keys with a 400, so a well-formed profile can never carry them — but the
 * always-on guarantee is the reason this taxonomy is safe at all, and making it hold
 * *here*, at the single composition seam, means a stale or hand-crafted `hidden_views`
 * cannot empty someone's nav either.
 *
 * The `scheduleInDeliver` placement opt-in (ADR-0203, #1645) that used to be applied here
 * is retired by ADR-0942 §3 / #3137: every view appears in exactly one band in any given
 * render, because a nav item listed twice is two objects to the person using it. Pure →
 * unit-testable.
 */
export function groupedVisibleViewsForUser(
  methodology: Methodology,
  hiddenViews: ReadonlySet<string>,
): VisibleViewGroup[] {
  return groupedVisibleViews(methodology)
    .map((g) => ({
      ...g,
      visibleViews: g.visibleViews.filter((v) => !hiddenViews.has(v) || ALWAYS_ON_VIEW_KEYS.has(v)),
    }))
    .filter((g) => g.visibleViews.length > 0);
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
