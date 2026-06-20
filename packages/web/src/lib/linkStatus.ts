/**
 * Canonical external-link-status model (#637 / #767, ADR-0153).
 *
 * Single source of truth on the web for:
 *  - the `ExternalLinkStatus` union,
 *  - the worst-status precedence (used to roll up a task's links into one glyph),
 *  - the design-system color tokens for the DOM surfaces (detail-drawer badge,
 *    task-list-row glyph).
 *
 * The Gantt canvas can't use Tailwind classes, so it owns its own hex map keyed
 * by the same status union (see GanttRenderer COLOR/COLOR_DARK link* entries).
 *
 * The precedence here MUST match the Python `LINK_STATUS_RANK` in
 * `apps/integrations/registry.py`; a unit test in each language pins the ordering
 * so the API annotation and the web rollup cannot drift.
 */

export type ExternalLinkStatus = 'open' | 'draft' | 'merged' | 'closed' | 'unknown';

/**
 * Worst-status precedence, most-attention-first. The *worst* status across a set
 * of links is the one with the lowest rank present. Mirrors the detail-drawer
 * badge color severity: critical → at-risk → on-track → success → neutral.
 */
export const LINK_STATUS_RANK: Record<ExternalLinkStatus, number> = {
  closed: 0,
  draft: 1,
  open: 2,
  merged: 3,
  unknown: 4,
};

/** Reduce a task's link statuses to the single worst one (null when empty). */
export function worstLinkStatus(
  statuses: readonly ExternalLinkStatus[],
): ExternalLinkStatus | null {
  let worst: ExternalLinkStatus | null = null;
  for (const status of statuses) {
    if (worst === null || LINK_STATUS_RANK[status] < LINK_STATUS_RANK[worst]) {
      worst = status;
    }
  }
  return worst;
}

/** Uppercase label for the detail-drawer badge. */
export const LINK_STATUS_LABEL: Record<ExternalLinkStatus, string> = {
  open: 'OPEN',
  draft: 'DRAFT',
  merged: 'MERGED',
  closed: 'CLOSED',
  unknown: 'UNKNOWN',
};

/**
 * Tailwind text-color token per status (detail-drawer badge label + list-row
 * glyph). No `info`/purple token exists, so MERGED maps to brand-primary (the
 * "landed/positive-terminal" color) and DRAFT to at-risk.
 */
export const LINK_STATUS_TEXT_CLASS: Record<ExternalLinkStatus, string> = {
  open: 'text-semantic-on-track',
  draft: 'text-semantic-at-risk',
  merged: 'text-brand-primary',
  closed: 'text-semantic-critical',
  unknown: 'text-neutral-text-secondary',
};

/** Tailwind dot-fill token per status (the small colored dot in the badge). */
export const LINK_STATUS_DOT_CLASS: Record<ExternalLinkStatus, string> = {
  open: 'bg-semantic-on-track',
  draft: 'bg-semantic-at-risk opacity-60',
  merged: 'bg-brand-primary',
  closed: 'bg-semantic-critical',
  unknown: 'border border-neutral-border',
};
