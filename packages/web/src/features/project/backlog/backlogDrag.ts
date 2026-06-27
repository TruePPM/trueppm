/**
 * Pure drag-resolution helpers for the unified Product-Backlog "By epic" surface
 * (ADR-0183). Extracted from {@link ProductBacklogPage} so the
 * reorder-vs-reparent disambiguation and the optimistic cross-group move are
 * unit-testable without driving dnd-kit in jsdom.
 *
 * Droppable id scheme: each epic group registers as `epic:<epicId>`; the
 * ungrouped ("No epic") bucket registers as the sentinel below. A dnd-kit `over`
 * target is therefore either a story id (a row) or one of these group ids (the
 * region itself — the only target an empty epic offers).
 */
import { arrayMove } from '@dnd-kit/sortable';
import type { Task } from '@/types';
import type { ProductBacklog } from './types';

/** Droppable id for the "No epic" bucket — dropping here clears `parent_epic`. */
export const UNGROUPED_KEY = 'epic:__ungrouped__';

export const epicDroppableId = (epicId: string): string => `epic:${epicId}`;
export const isEpicDroppableId = (id: string): boolean => id.startsWith('epic:');

/** The epic id a droppable key points at, or `null` for the ungrouped bucket. */
export function epicIdFromDroppableId(id: string): string | null {
  return id === UNGROUPED_KEY ? null : id.slice('epic:'.length);
}

/** Map every story id → the droppable key of the group it currently sits in. */
export function buildGroupKeyIndex(d: ProductBacklog): Map<string, string> {
  const m = new Map<string, string>();
  d.epics.forEach((g) => g.stories.forEach((s) => m.set(s.id, epicDroppableId(g.epic.id))));
  d.ungrouped.forEach((s) => m.set(s.id, UNGROUPED_KEY));
  return m;
}

/** Ordered story ids of a group identified by its droppable key. */
export function groupStoryIds(d: ProductBacklog, groupKey: string): string[] {
  if (groupKey === UNGROUPED_KEY) return d.ungrouped.map((s) => s.id);
  const epicId = epicIdFromDroppableId(groupKey);
  const g = d.epics.find((x) => x.epic.id === epicId);
  return g ? g.stories.map((s) => s.id) : [];
}

export type BacklogDrop =
  | { kind: 'reorder'; groupKey: string; orderedIds: string[] }
  | { kind: 'reparent'; storyId: string; parentEpicId: string | null }
  | { kind: 'noop' };

/**
 * Disambiguate a dnd-kit drop on the unified By-epic surface (ADR-0183 D2).
 *
 * - Dropped on a different row **in the same group** → reorder (rank-only path).
 * - Dropped on the same group's region with no row move → no-op.
 * - Dropped on a **different** group (its region, header, or any row inside it) →
 *   reparent the dragged story into that group (or to `null` for the ungrouped
 *   bucket). The exact intra-target position is the server's call (the story keeps
 *   its priority_rank), so a reparent never carries an ordered-id list.
 */
export function resolveBacklogDrop(
  d: ProductBacklog,
  groupKeyIndex: Map<string, string>,
  activeId: string,
  overId: string | null,
): BacklogDrop {
  if (!overId) return { kind: 'noop' };
  const sourceKey = groupKeyIndex.get(activeId);
  if (!sourceKey) return { kind: 'noop' };
  const targetKey = isEpicDroppableId(overId) ? overId : groupKeyIndex.get(overId);
  if (!targetKey) return { kind: 'noop' };

  if (targetKey === sourceKey) {
    // Same group: only a drop onto a *different row* reorders. A drop onto the
    // region droppable itself (no row under the cursor) carries no new position.
    if (overId === activeId || isEpicDroppableId(overId)) return { kind: 'noop' };
    const ids = groupStoryIds(d, sourceKey);
    const oldIndex = ids.indexOf(activeId);
    const newIndex = ids.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return { kind: 'noop' };
    return { kind: 'reorder', groupKey: sourceKey, orderedIds: arrayMove(ids, oldIndex, newIndex) };
  }

  return { kind: 'reparent', storyId: activeId, parentEpicId: epicIdFromDroppableId(targetKey) };
}

/**
 * Optimistic cross-group move of a story (ADR-0183 D3). The moved row is placed in
 * the target group preserving the **global priority order** of the snapshot, so it
 * lands by its existing priority_rank rather than jumping to the end — the server
 * reconciles the exact rank on the post-mutation invalidate. Returns the snapshot
 * unchanged if the story id is not present.
 */
export function moveStoryToGroup(
  d: ProductBacklog,
  storyId: string,
  parentEpicId: string | null,
): ProductBacklog {
  const globalOrder: Task[] = [...d.epics.flatMap((g) => g.stories), ...d.ungrouped];
  const moved = globalOrder.find((s) => s.id === storyId);
  if (!moved) return d;
  const orderIndex = new Map(globalOrder.map((s, i) => [s.id, i] as const));
  const without = (arr: Task[]): Task[] => arr.filter((s) => s.id !== storyId);
  const withMoved = (arr: Task[]): Task[] =>
    [...arr, moved].sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0));

  return {
    ...d,
    epics: d.epics.map((g) =>
      g.epic.id === parentEpicId
        ? { ...g, stories: withMoved(without(g.stories)) }
        : { ...g, stories: without(g.stories) },
    ),
    ungrouped: parentEpicId === null ? withMoved(without(d.ungrouped)) : without(d.ungrouped),
  };
}
