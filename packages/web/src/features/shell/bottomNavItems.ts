import type { Methodology } from '@/types';

/**
 * Mobile bottom-rail view selection (ADR-0196). Pure — no React, no hooks — so
 * the ≤5-slot split rule is trivially unit-testable and stays out of
 * `methodologyTabs.ts` (which owns the *desktop* grouped bar and is edited
 * heavily by ADR-0195; keeping mobile order here avoids a merge collision).
 *
 * The mobile rail shares the desktop *set* of reachable views (composed by the
 * caller through the same `methodologyTabs.ts` helpers + role gate) but not the
 * desktop *order*: desktop group order front-loads PLAN, which would bury Today
 * and regress issue 1324. Mobile leads with the views a phone user taps daily.
 */

/**
 * Per-methodology primary-priority order — the views preferred for the primary
 * rail, in order. `selectMobileNav` takes the first up-to-4 of these that are
 * reachable, then backfills from the canonical order. `overview` heads every
 * list (always-on landing) and `today` is always second (the issue-1324
 * headline-view guarantee).
 *
 * - AGILE/HYBRID lead with Board + Backlog — the sprint circuit's daily pair
 *   (fixes the PO/Scrum-Master blockers; coherent with the desktop SPRINT group,
 *   ADR-0195).
 * - WATERFALL leads with Schedule + Grid — the schedule-first daily pair.
 */
export const MOBILE_PRIMARY_PRIORITY: Record<Methodology, readonly string[]> = {
  WATERFALL: ['overview', 'today', 'schedule', 'grid'],
  AGILE: ['overview', 'today', 'board', 'product-backlog'],
  HYBRID: ['overview', 'today', 'board', 'product-backlog'],
};

/**
 * Canonical display order for any view not promoted into the primary set. Drives
 * the "More" overflow sheet order and primary backfill. `settings` sorts last
 * (admin, infrequent); `overview` first (though it is always primary in
 * practice). A view absent here would never render in the overflow — keep this
 * in sync with the view vocabulary in `viewMeta.ts`.
 */
export const CANONICAL_VIEW_ORDER: readonly string[] = [
  'overview',
  'today',
  'board',
  'product-backlog',
  'sprints',
  'schedule',
  'grid',
  'calendar',
  'resources',
  'risk',
  'reports',
  'settings',
];

/**
 * Views anchored to the front of the primary rail regardless of methodology or
 * user pins: `overview` (always-on landing) then `today` (the issue-1324
 * headline-view guarantee). User pins fill the *remaining* primary slots — they
 * never displace these two, so Today can't be buried by a pin.
 */
export const ANCHOR_VIEWS: readonly string[] = ['overview', 'today'];

/** Max cells in the rail. Slot 5 becomes "More" when the reachable set exceeds this. */
export const MOBILE_RAIL_SLOTS = 5;
const MAX_PRIMARY_WITH_OVERFLOW = MOBILE_RAIL_SLOTS - 1; // 4 tabs + a More button

export interface MobileNavSplit {
  /** Views rendered as primary rail tabs (≤5, or ≤4 when `overflow` is non-empty). */
  primary: string[];
  /** Views rendered inside the "More" bottom sheet (canonical order, `settings` last). */
  overflow: string[];
}

/**
 * Order the reachable set for the rail. Precedence, front to back:
 *   1. anchors (`overview`, `today`) — never displaced (issue 1324);
 *   2. user pins in pin order (issue 1591) — the user's chosen primary views;
 *   3. methodology-priority views (ADR-0196 defaults);
 *   4. everything else in canonical order.
 * Each view is placed once, at its highest-precedence position.
 */
function orderReachable(
  reachable: Iterable<string>,
  methodology: Methodology,
  pinned: readonly string[],
): string[] {
  const set = new Set(reachable);
  const anchors = ANCHOR_VIEWS.filter((v) => set.has(v));
  const placed = new Set<string>(anchors);
  const pins = pinned.filter((v) => set.has(v) && !placed.has(v));
  pins.forEach((v) => placed.add(v));
  const priority = MOBILE_PRIMARY_PRIORITY[methodology].filter((v) => set.has(v) && !placed.has(v));
  priority.forEach((v) => placed.add(v));
  const rest = CANONICAL_VIEW_ORDER.filter((v) => set.has(v) && !placed.has(v));
  return [...anchors, ...pins, ...priority, ...rest];
}

/**
 * Split the reachable views into the primary rail and the "More" overflow
 * (ADR-0196). If everything fits in {@link MOBILE_RAIL_SLOTS}, all views render
 * as tabs and `overflow` is empty (no More button). Otherwise the first 4 in
 * priority-then-canonical order are primary and the rest overflow.
 *
 * `reachable` is the caller-composed set (methodology filter ∩ per-project
 * surface visibility ∩ per-user hidden_views ∩ role gate, ∪ {overview, settings})
 * — this function is purely about ordering and the ≤5 cap.
 *
 * `pinned` is the user's per-user pinned view keys (issue 1591). Pins are
 * promoted into the primary slots ahead of the methodology defaults, but behind
 * the {@link ANCHOR_VIEWS}, so a pin can claim slot 3/4 (e.g. a construction PM
 * pinning Schedule) without ever burying Overview or Today. Unreachable pins are
 * ignored. Defaults to no pins, preserving the pure ADR-0196 ordering.
 */
export function selectMobileNav(
  reachable: Iterable<string>,
  methodology: Methodology,
  pinned: readonly string[] = [],
): MobileNavSplit {
  const ordered = orderReachable(reachable, methodology, pinned);
  if (ordered.length <= MOBILE_RAIL_SLOTS) {
    return { primary: ordered, overflow: [] };
  }
  return {
    primary: ordered.slice(0, MAX_PRIMARY_WITH_OVERFLOW),
    overflow: ordered.slice(MAX_PRIMARY_WITH_OVERFLOW),
  };
}
