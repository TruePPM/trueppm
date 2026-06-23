/**
 * Group a flat Decisions list by sprint for the Decisions view (ADR-0165, issue 748).
 *
 * The server already orders newest-sprint-first with the backlog (sprint-less) group
 * trailing, so this preserves first-encounter order rather than re-sorting — each sprint
 * becomes one section (keyed by sprint id) in the order it first appears, and every row
 * of that sprint lands in it. The server never interleaves sprints, so first-encounter
 * order is the display order.
 */

import type { DecisionNote } from '@/types';

export interface DecisionSprintGroup {
  /** Sprint id, or null for the backlog (sprint-less) group. */
  sprintId: string | null;
  /** Section header label — the sprint name, or "No sprint" for the backlog group. */
  label: string;
  /** Sprint state for the header badge; null for the backlog group. */
  state: string | null;
  decisions: DecisionNote[];
}

const BACKLOG_KEY = '__backlog__';

export function groupDecisionsBySprint(decisions: DecisionNote[]): DecisionSprintGroup[] {
  const groups: DecisionSprintGroup[] = [];
  const positionByKey = new Map<string, number>();
  for (const d of decisions) {
    const sprintId = d.sprint?.id ?? null;
    const key = sprintId ?? BACKLOG_KEY;
    const pos = positionByKey.get(key);
    if (pos === undefined) {
      positionByKey.set(key, groups.length);
      groups.push({
        sprintId,
        label: d.sprint?.name ?? 'No sprint',
        state: d.sprint?.state ?? null,
        decisions: [d],
      });
    } else {
      groups[pos].decisions.push(d);
    }
  }
  return groups;
}
