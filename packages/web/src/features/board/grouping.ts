/**
 * Board swimlane grouping (issue 324; `epic` added in issue 364).
 *
 * The board can group its swimlanes three ways:
 *   - `phase`    — by WBS summary parent (the original `buildPhases` in BoardView)
 *   - `assignee` — by the card's primary assignee, with an "Unassigned" lane
 *   - `epic`     — by the card's parent epic (Task.parent_epic), with a
 *                  "(No epic)" lane for ungrouped cards
 *
 * This module owns the *assignee* and *epic* grouping so BoardView's phase logic
 * stays put (and the surface area of this change against a parallel board edit
 * stays small). All modes produce the same `BoardLane` shape, so the lane
 * render, the per-status `phaseTaskMap`, and the drag handler are mode-agnostic.
 *
 * Team grouping and drag-to-reassign are deliberately out of scope — see 324/364:
 * team needs a `task.team` API field (it is derived via TeamMembership today),
 * and reassign-on-drag (changing an assignee or a parent epic by dropping a card
 * into another lane) is a separate write-path design pass. The epic lens is
 * therefore read-only: the epic FK is edited from the card's detail drawer.
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

/** Lane id for cards with no parent epic. A literal (never a task id). */
export const NO_EPIC_LANE_ID = '__no_epic__';

/**
 * The lane a task belongs to under epic grouping: its `parentEpic` id, or the
 * `(No epic)` sentinel. Used by the drag handler to detect a cross-lane drop
 * (a deferred reassign) without re-deriving the grouping — mirrors
 * `primaryAssigneeLaneId`.
 */
export function epicLaneId(task: Task): string {
  return task.parentEpic ?? NO_EPIC_LANE_ID;
}

/**
 * Group leaf cards into one lane per parent epic. Summary tasks (WBS structure)
 * and epic-type tasks (grouping nodes, never cards) are excluded — in epic mode
 * an epic is a lane *header*, not a card under its own lane. `epicNames` maps an
 * epic task id to its display name (built by the caller from the full task set,
 * since an epic story's parent may sit outside the committed/in-sprint slice);
 * an id absent from the map falls back to "Epic". Lanes are sorted
 * alphabetically by epic name with the "(No epic)" lane pinned last, and only
 * lanes that actually hold cards are returned (no empty-epic noise).
 */
export function buildEpicLanes(allTasks: Task[], epicNames: Map<string, string>): BoardLane[] {
  const byLane = new Map<string, { name: string; tasks: Task[] }>();
  for (const t of allTasks) {
    if (t.isSummary || t.taskType === 'epic') continue;
    const laneId = t.parentEpic ?? NO_EPIC_LANE_ID;
    const laneName = laneId === NO_EPIC_LANE_ID ? '(No epic)' : (epicNames.get(laneId) ?? 'Epic');
    const existing = byLane.get(laneId);
    if (existing) existing.tasks.push(t);
    else byLane.set(laneId, { name: laneName, tasks: [t] });
  }

  const epicLanes: BoardLane[] = [];
  let noEpic: BoardLane | null = null;
  for (const [id, { name, tasks }] of byLane) {
    const lane: BoardLane = { id, name, tasks, summaryTask: undefined };
    if (id === NO_EPIC_LANE_ID) noEpic = lane;
    else epicLanes.push(lane);
  }
  epicLanes.sort((a, b) => a.name.localeCompare(b.name));
  return noEpic ? [...epicLanes, noEpic] : epicLanes;
}
