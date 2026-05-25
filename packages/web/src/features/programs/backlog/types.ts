/**
 * Program-backlog domain types — the UI contract pinned by ADR-0069.
 *
 * The field shapes here mirror what the (still-unbuilt) `BacklogItem` API
 * (#737) will return, so the fixture-backed hooks in `./hooks` can be swapped
 * for real queries without touching any component. Do not add UI-only fields
 * to `BacklogItem` — denormalized display data (owner name, project meta)
 * lives in the sibling `BacklogMember` / `MemberProject` types instead.
 */

export type BacklogItemStatus = 'PROPOSED' | 'PULLED' | 'ARCHIVED';

export type BacklogItemType = 'epic' | 'story' | 'spike' | 'chore' | 'bug';

/** The five item types, in the order they appear in dropdowns. */
export const BACKLOG_ITEM_TYPES: readonly BacklogItemType[] = [
  'story',
  'epic',
  'spike',
  'chore',
  'bug',
] as const;

/** Where a PULLED item landed — links the item to the task it created. */
export interface BacklogPullLink {
  projectId: string;
  projectName: string;
  taskId: string;
  /** ISO timestamp of the pull. */
  at: string;
}

/** A single program-backlog row, per the ADR-0069 contract. */
export interface BacklogItem {
  id: string; // BI-001
  programId: string;
  title: string;
  description?: string;
  itemType: BacklogItemType;
  status: BacklogItemStatus;
  tags: string[];
  /** Integer; lower = higher priority. Sort key for the list. */
  priorityRank: number;
  assigneeId?: string;
  createdAt: string;
  updatedAt: string;
  /** Present only when `status === 'PULLED'`. */
  pulledTo?: BacklogPullLink;
}

/** A program member — resolves `assigneeId` to a display name + avatar. */
export interface BacklogMember {
  id: string;
  name: string;
  /** 1–2 character avatar initials, e.g. "RK". */
  initials: string;
}

/** A project the program owns — a candidate pull target. */
export interface MemberProject {
  id: string;
  name: string;
  /** Short project code shown in the picker meta line, e.g. "ARTM-3". */
  code: string;
  /** Hex stripe color shown left of the name in the radio picker. */
  color: string;
  /** Count of items already in this project's backlog (picker meta). */
  backlogCount: number;
}

/** Status values the inline status dropdown may set (PULLED excluded — that
 *  transition only happens via the Pull action, per ADR-0069). */
export const SETTABLE_STATUSES: readonly BacklogItemStatus[] = ['PROPOSED', 'ARCHIVED'] as const;
