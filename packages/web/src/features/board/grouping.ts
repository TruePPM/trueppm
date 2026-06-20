/**
 * Board swimlane grouping (issue #324).
 *
 * The board can group its swimlanes two ways:
 *   - `phase`    — by WBS summary parent (the original `buildPhases` in BoardView)
 *   - `assignee` — by the card's primary assignee, with an "Unassigned" lane
 *
 * This module owns the *assignee* grouping so BoardView's phase logic stays put
 * (and the surface area of this change against a parallel board edit stays small).
 * Both modes produce the same `BoardLane` shape, so the lane render, the
 * per-status `phaseTaskMap`, and the drag handler are mode-agnostic.
 *
 * Team grouping and drag-to-reassign are deliberately out of scope — see #324:
 * team needs a `task.team` API field (it is derived via TeamMembership today),
 * and reassign-on-drag is a separate write-path design pass over the
 * multi-resource TaskResource endpoint.
 */
import type { Task } from '@/types';

/** A swimlane on the board. `summaryTask` is undefined for non-phase lanes. */
export interface BoardLane {
  id: string;
  name: string;
  tasks: Task[];
  summaryTask: Task | undefined;
}

/** Lane id for cards with no assignee. A literal (never a resource id). */
export const UNASSIGNED_LANE_ID = 'unassigned';

/**
 * The lane a task belongs to under assignee grouping: its primary assignee's
 * resource id (the first of `assignees`, matching how the card chip picks the
 * lead) or the `unassigned` sentinel. Used by the drag handler to detect a
 * cross-lane (reassign) drop without re-deriving the grouping.
 */
export function primaryAssigneeLaneId(task: Task): string {
  return task.assignees[0]?.resourceId ?? UNASSIGNED_LANE_ID;
}

/**
 * Group leaf cards into one lane per primary assignee. Summary tasks are WBS
 * structure, not assignable work, so they are excluded entirely (in phase mode
 * they are lane *headers*; here they have no place). Lanes are sorted
 * alphabetically by assignee name with the "Unassigned" lane pinned last, and
 * only lanes that actually hold cards are returned (no empty-assignee noise).
 */
export function buildAssigneeLanes(allTasks: Task[]): BoardLane[] {
  const byLane = new Map<string, { name: string; tasks: Task[] }>();
  for (const t of allTasks) {
    if (t.isSummary) continue;
    const primary = t.assignees[0];
    const laneId = primary?.resourceId ?? UNASSIGNED_LANE_ID;
    const laneName = primary?.name ?? 'Unassigned';
    const existing = byLane.get(laneId);
    if (existing) existing.tasks.push(t);
    else byLane.set(laneId, { name: laneName, tasks: [t] });
  }

  const assigneeLanes: BoardLane[] = [];
  let unassigned: BoardLane | null = null;
  for (const [id, { name, tasks }] of byLane) {
    const lane: BoardLane = { id, name, tasks, summaryTask: undefined };
    if (id === UNASSIGNED_LANE_ID) unassigned = lane;
    else assigneeLanes.push(lane);
  }
  assigneeLanes.sort((a, b) => a.name.localeCompare(b.name));
  return unassigned ? [...assigneeLanes, unassigned] : assigneeLanes;
}
