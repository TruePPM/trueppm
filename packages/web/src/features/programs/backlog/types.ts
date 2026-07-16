/**
 * Program-backlog domain types — the UI's view of the ADR-0069 `BacklogItem`
 * API (#737). Field names are camelCase here; the snake_case API shapes are
 * mapped at the boundary in `./api`. Only fields the real serializer exposes
 * are modeled — the API has no assignee, and a pulled item links to a task id
 * (not a project name), so those are absent / optional accordingly.
 */

export type BacklogItemStatus = 'PROPOSED' | 'PULLED' | 'ARCHIVED';

export type BacklogItemType = 'epic' | 'feature' | 'story' | 'task' | 'spike' | 'chore' | 'bug';

/**
 * The item types, in the order they appear in dropdowns and facet filters.
 * Reconciled with the backend `BacklogItemType` enum (#1995) so a created type
 * always round-trips and pull carries its true kind (`chore`→tech debt,
 * `feature`→task) instead of silently collapsing to a plain task.
 */
export const BACKLOG_ITEM_TYPES: readonly BacklogItemType[] = [
  'story',
  'epic',
  'feature',
  'task',
  'bug',
  'spike',
  'chore',
] as const;

/**
 * Whether a story-points estimate is relevant to this item type (#2026).
 * Epics and Features are containers, not estimable leaf work — and the program
 * backlog is a flat list with no epic→child hierarchy, so there is nothing to
 * roll up into an Epic total here. Both therefore hide the points field; every
 * leaf work item (story/task/bug/spike/chore) keeps it. Defined as an exclusion
 * so a future leaf type is estimable by default. (The read-only rolled-up Epic
 * total belongs on the project product-backlog, where the hierarchy exists —
 * tracked in the estimation-scale work, #2027.)
 */
export function itemTypeShowsPoints(type: BacklogItemType): boolean {
  return type !== 'epic' && type !== 'feature';
}

/**
 * Where a PULLED item landed. `taskId`/`at` come from the item itself; the
 * serializer also exposes `pulled_task_project_id`/`pulled_task_project_name`
 * (#1994), so `projectId`/`projectName` survive a reload and back the "Go to
 * task" wayfinding deep-link. They stay optional because they are `null` for a
 * not-yet-pulled item (mapped to `undefined` at the boundary).
 */
export interface BacklogPullLink {
  taskId: string;
  /** ISO timestamp of the pull. */
  at: string;
  projectId?: string;
  projectName?: string;
}

/** A single program-backlog row, mapped from the `BacklogItem` serializer. */
export interface BacklogItem {
  /** UUID primary key. */
  id: string;
  programId: string;
  title: string;
  description?: string;
  itemType: BacklogItemType;
  status: BacklogItemStatus;
  tags: string[];
  /** Integer; lower = higher priority. Sort key for the list. */
  priorityRank: number;
  /** Optional agile estimate (`story_points`); surfaced read-only where shown. */
  storyPoints?: number | null;
  serverVersion: number;
  createdAt: string;
  updatedAt: string;
  /** Present only when `status === 'PULLED'`. */
  pulledTo?: BacklogPullLink;
}

/** A project the program owns — a candidate pull target. */
export interface MemberProject {
  id: string;
  name: string;
  /** Short project code shown in the picker meta line, when available. */
  code?: string;
  /** Hex stripe color shown left of the name in the radio picker. */
  color?: string;
  /** Count of items already in this project's backlog, when available. */
  backlogCount?: number;
}

/** Status values the inline status dropdown may set (PULLED excluded — that
 *  transition only happens via the Pull action, per ADR-0069). */
export const SETTABLE_STATUSES: readonly BacklogItemStatus[] = ['PROPOSED', 'ARCHIVED'] as const;
