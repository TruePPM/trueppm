import type { Methodology } from '@/types';

/**
 * Tab visibility matrix per methodology preset (ADR-0041, amended by ADR-0053).
 *
 * Matrix:
 * | Tab       | WATERFALL | AGILE | HYBRID |
 * |-----------|-----------|-------|--------|
 * | overview  | ✅        | ✅    | ✅     |
 * | board     | ✅        | ✅    | ✅     |
 * | sprints   | ❌        | ✅    | ✅     |
 * | schedule  | ✅        | ❌    | ✅     |
 * | grid      | ✅        | ✅    | ✅     |
 * | calendar  | ✅        | ❌    | ✅     |
 * | resources | ✅        | ✅    | ✅     |
 * | risk      | ✅        | ✅    | ✅     |
 *
 * `grid` replaces the legacy `wbs` + `list` entries (issue #334). Outline mode
 * inside Grid covers the WBS use case for WATERFALL and HYBRID; Flat mode is
 * the AGILE default (per `methodologyDefaultMode` in `features/grid/`).
 *
 * Tabs hidden by methodology are still reachable by direct URL — the preset
 * communicates "this is not how we work here", not "this is not allowed".
 */
const HIDDEN_FOR_METHODOLOGY: Record<Methodology, ReadonlySet<string>> = {
  WATERFALL: new Set(['sprints']),
  AGILE: new Set(['schedule', 'calendar']),
  HYBRID: new Set(),
};

export function isTabVisibleForMethodology(view: string, methodology: Methodology): boolean {
  return !HIDDEN_FOR_METHODOLOGY[methodology].has(view);
}
