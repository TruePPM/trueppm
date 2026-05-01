import type { Methodology } from '@/types';

/**
 * Tab visibility matrix per methodology preset (ADR-0041).
 *
 * Matrix:
 * | Tab       | WATERFALL | AGILE | HYBRID |
 * |-----------|-----------|-------|--------|
 * | overview  | ✅        | ✅    | ✅     |
 * | board     | ✅        | ✅    | ✅     |
 * | sprints   | ❌        | ✅    | ✅     |
 * | schedule  | ✅        | ❌    | ✅     |
 * | wbs       | ✅        | ❌    | ✅     |
 * | list      | ✅        | ✅    | ✅     |
 * | calendar  | ✅        | ❌    | ✅     |
 * | resources | ✅        | ✅    | ✅     |
 * | risk      | ✅        | ✅    | ✅     |
 *
 * Tabs hidden by methodology are still reachable by direct URL — the preset
 * communicates "this is not how we work here", not "this is not allowed".
 */
const HIDDEN_FOR_METHODOLOGY: Record<Methodology, ReadonlySet<string>> = {
  WATERFALL: new Set(['sprints']),
  AGILE: new Set(['schedule', 'wbs', 'calendar']),
  HYBRID: new Set(),
};

export function isTabVisibleForMethodology(view: string, methodology: Methodology): boolean {
  return !HIDDEN_FOR_METHODOLOGY[methodology].has(view);
}
