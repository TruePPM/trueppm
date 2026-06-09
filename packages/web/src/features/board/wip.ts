/**
 * Shared WIP-limit banding (#232, #546).
 *
 * Every WIP-limit surface — board column headers/badges, the sprint-panel
 * header chip, future swimlane/column counters — must read the SAME three-band
 * model so a given `count/limit` state looks identical everywhere it appears:
 *
 *   count <  limit  → 'under' (neutral, no warning chrome)
 *   count == limit  → 'at'    (at-risk amber)
 *   count >  limit  → 'over'  (critical red)
 *   limit == null   → 'none'  (no limit configured)
 *
 * Reuse `wipState()` rather than a local `count > limit` check so the bands
 * never drift between surfaces.
 */
export type WipState = 'under' | 'at' | 'over' | 'none';

/** Returns the WIP-state band for a count against an optional limit. */
export function wipState(count: number, limit: number | null | undefined): WipState {
  if (limit == null) return 'none';
  if (count > limit) return 'over';
  if (count >= limit) return 'at';
  return 'under';
}
