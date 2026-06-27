/**
 * Pure drag-resolution helpers for the unified "By epic" surface (ADR-0183, #1345).
 *
 * These cover the reorder-vs-reparent disambiguation and the optimistic cross-group
 * move without driving dnd-kit in jsdom — the brittle gesture is exercised structurally
 * in the Playwright spec, the *logic* lives here.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import type { ProductBacklog } from './types';
import {
  UNGROUPED_KEY,
  buildGroupKeyIndex,
  epicDroppableId,
  epicIdFromDroppableId,
  groupStoryIds,
  isEpicDroppableId,
  moveStoryToGroup,
  resolveBacklogDrop,
} from './backlogDrag';

const story = (id: string): Task => ({ id, name: id }) as Task;

/** EP1[S1, S2] · EP2[S3] · ungrouped[S4]. Global priority order: S1, S2, S3, S4. */
function makeBacklog(): ProductBacklog {
  return {
    epics: [
      {
        epic: story('EP1'),
        stories: [story('S1'), story('S2')],
        rollup: { storyCount: 2, pointsTotal: 0, pointsDone: 0 },
      },
      {
        epic: story('EP2'),
        stories: [story('S3')],
        rollup: { storyCount: 1, pointsTotal: 0, pointsDone: 0 },
      },
    ],
    ungrouped: [story('S4')],
    health: {
      dorPct: 0,
      readyCount: 0,
      readyPoints: 0,
      capacityPoints: null,
      unestimated: 0,
      acMet: 0,
      acTotal: 0,
      storyCount: 4,
    },
    scoring: { model: 'none' },
  };
}

const ids = (arr: Task[]): string[] => arr.map((s) => s.id);

describe('droppable id scheme', () => {
  it('round-trips an epic id through its droppable key', () => {
    expect(epicDroppableId('EP1')).toBe('epic:EP1');
    expect(epicIdFromDroppableId('epic:EP1')).toBe('EP1');
  });

  it('treats the ungrouped sentinel as an epic-shaped droppable that maps to null', () => {
    expect(isEpicDroppableId(UNGROUPED_KEY)).toBe(true);
    expect(epicIdFromDroppableId(UNGROUPED_KEY)).toBeNull();
  });

  it('distinguishes a group droppable from a story row id', () => {
    expect(isEpicDroppableId('epic:EP1')).toBe(true);
    expect(isEpicDroppableId('S1')).toBe(false);
  });
});

describe('buildGroupKeyIndex', () => {
  it('maps every story to the droppable key of its current group', () => {
    const idx = buildGroupKeyIndex(makeBacklog());
    expect(idx.get('S1')).toBe('epic:EP1');
    expect(idx.get('S2')).toBe('epic:EP1');
    expect(idx.get('S3')).toBe('epic:EP2');
    expect(idx.get('S4')).toBe(UNGROUPED_KEY);
  });
});

describe('groupStoryIds', () => {
  const d = makeBacklog();
  it('returns the ordered ids of an epic group', () => {
    expect(groupStoryIds(d, 'epic:EP1')).toEqual(['S1', 'S2']);
  });
  it('returns the ungrouped ids for the sentinel key', () => {
    expect(groupStoryIds(d, UNGROUPED_KEY)).toEqual(['S4']);
  });
  it('returns [] for an unknown group key', () => {
    expect(groupStoryIds(d, 'epic:NOPE')).toEqual([]);
  });
});

describe('resolveBacklogDrop', () => {
  const d = makeBacklog();
  const idx = buildGroupKeyIndex(d);
  const resolve = (activeId: string, overId: string | null) =>
    resolveBacklogDrop(d, idx, activeId, overId);

  it('reorders when dropped on a different row in the same group', () => {
    expect(resolve('S1', 'S2')).toEqual({
      kind: 'reorder',
      groupKey: 'epic:EP1',
      orderedIds: ['S2', 'S1'],
    });
  });

  it('is a no-op when dropped on the source group region (no row under the cursor)', () => {
    expect(resolve('S1', 'epic:EP1')).toEqual({ kind: 'noop' });
  });

  it('is a no-op when dropped on itself', () => {
    expect(resolve('S1', 'S1')).toEqual({ kind: 'noop' });
  });

  it('reparents into another epic when dropped on a row inside it', () => {
    expect(resolve('S1', 'S3')).toEqual({ kind: 'reparent', storyId: 'S1', parentEpicId: 'EP2' });
  });

  it('reparents into another epic when dropped on that epic’s region droppable', () => {
    expect(resolve('S1', 'epic:EP2')).toEqual({
      kind: 'reparent',
      storyId: 'S1',
      parentEpicId: 'EP2',
    });
  });

  it('reparents to null (ungroup) when dropped on the No-epic bucket', () => {
    expect(resolve('S1', UNGROUPED_KEY)).toEqual({
      kind: 'reparent',
      storyId: 'S1',
      parentEpicId: null,
    });
  });

  it('reparents an ungrouped story into an epic', () => {
    expect(resolve('S4', 'epic:EP1')).toEqual({
      kind: 'reparent',
      storyId: 'S4',
      parentEpicId: 'EP1',
    });
  });

  it('is a no-op with no drop target', () => {
    expect(resolve('S1', null)).toEqual({ kind: 'noop' });
  });

  it('is a no-op when the dragged id is unknown', () => {
    expect(resolve('NOPE', 'S3')).toEqual({ kind: 'noop' });
  });
});

describe('moveStoryToGroup', () => {
  it('moves a story into another epic, landing by global priority order', () => {
    const next = moveStoryToGroup(makeBacklog(), 'S1', 'EP2');
    expect(ids(next.epics[0].stories)).toEqual(['S2']); // EP1 lost S1
    expect(ids(next.epics[1].stories)).toEqual(['S1', 'S3']); // EP2 gained S1 ahead of S3 by rank
    expect(ids(next.ungrouped)).toEqual(['S4']); // untouched
  });

  it('moves an ungrouped story into an epic', () => {
    const next = moveStoryToGroup(makeBacklog(), 'S4', 'EP1');
    expect(ids(next.epics[0].stories)).toEqual(['S1', 'S2', 'S4']);
    expect(ids(next.ungrouped)).toEqual([]);
  });

  it('moves a story out of all epics into the ungrouped bucket', () => {
    const next = moveStoryToGroup(makeBacklog(), 'S1', null);
    expect(ids(next.epics[0].stories)).toEqual(['S2']);
    expect(ids(next.ungrouped)).toEqual(['S1', 'S4']); // S1 lands ahead of S4 by rank
  });

  it('returns the snapshot unchanged when the story id is not present', () => {
    const d = makeBacklog();
    expect(moveStoryToGroup(d, 'NOPE', 'EP1')).toBe(d);
  });
});
