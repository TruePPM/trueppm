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
 * Where a PULLED item landed. The API exposes only the created task id and
 * timestamp; `projectId`/`projectName` are known optimistically (the user just
 * picked the target) but are not returned by the list serializer, so they are
 * optional and absent after a reload.
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
