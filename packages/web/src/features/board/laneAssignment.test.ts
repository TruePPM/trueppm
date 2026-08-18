import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import { FIXTURE_TASKS } from '@/fixtures/tasks';
import { buildLaneIndex, collectLaneHeads, ROOT_LANE_ID } from './laneAssignment';

/**
 * A task shaped only by what the lane rule reads. Everything else comes off a
 * real fixture so the object stays a valid `Task` as the type grows.
 */
function t(over: Partial<Task> & { id: string }): Task {
  return { ...FIXTURE_TASKS[0], parentId: null, isSummary: false, ...over };
}

/** 1 Mobilization > 1.1 Permits; 2 Procurement > 2.3 Electrical > 2.3.1 Switchgear PO. */
const TREE: Task[] = [
  t({ id: 'p1', name: 'Mobilization', isSummary: true }),
  t({ id: 'p1a', name: 'Site access permits', parentId: 'p1' }),
  t({ id: 'p2', name: 'Long-lead procurement', isSummary: true }),
  t({ id: 'p2c', name: 'Electrical', parentId: 'p2', isSummary: true }),
  t({ id: 'p2c1', name: 'Switchgear PO', parentId: 'p2c' }),
  t({ id: 'r1', name: 'Insurance certificate' }),
];

describe('buildLaneIndex — invariant 1: a container is never a card', () => {
  it('gives no placement to a container, at any depth', () => {
    const index = buildLaneIndex(TREE);
    expect(index.has('p1')).toBe(false);
    expect(index.has('p2')).toBe(false);
    // The nested container is the one the old buildPhases turned into a lane
    // *and* left eligible as a card.
    expect(index.has('p2c')).toBe(false);
  });

  it('treats a row with observed children as a container even when the server did not annotate it', () => {
    // A payload without `isSummary`, or an optimistic child inserted before the
    // refetch, must not leave the parent rendering as a card next to its own work.
    const stale: Task[] = [
      t({ id: 'a', name: 'Assess', isSummary: false }),
      t({ id: 'a1', name: 'Inventory racks', parentId: 'a' }),
    ];
    const index = buildLaneIndex(stale);
    expect(index.has('a')).toBe(false);
    expect(index.get('a1')?.laneId).toBe('a');
  });
});

describe('buildLaneIndex — invariant 2: every task appears exactly once', () => {
  it('places each non-container task exactly once', () => {
    const index = buildLaneIndex(TREE);
    const cards = TREE.filter((x) => index.has(x.id)).map((x) => x.id);
    expect(cards).toEqual(['p1a', 'p2c1', 'r1']);
    expect(new Set(cards).size).toBe(cards.length);
  });

  it('routes a deeply nested card to its TOP-LEVEL ancestor, not its nearest one', () => {
    // The whole point: depth must not multiply lanes.
    expect(buildLaneIndex(TREE).get('p2c1')?.laneId).toBe('p2');
  });

  it('names the nearest container as the crumb when it is not the lane', () => {
    expect(buildLaneIndex(TREE).get('p2c1')?.crumb).toBe('Electrical');
  });

  it('carries no crumb when the card sits directly in its lane', () => {
    expect(buildLaneIndex(TREE).get('p1a')?.crumb).toBeNull();
  });

  it('collapses a four-level branch onto one lane with a single crumb', () => {
    const deep: Task[] = [
      t({ id: 'l1', name: 'One', isSummary: true }),
      t({ id: 'l2', name: 'Two', parentId: 'l1', isSummary: true }),
      t({ id: 'l3', name: 'Three', parentId: 'l2', isSummary: true }),
      t({ id: 'leaf', name: 'Leaf', parentId: 'l3' }),
    ];
    expect(buildLaneIndex(deep).get('leaf')).toEqual({ laneId: 'l1', crumb: 'Three' });
    expect(collectLaneHeads(deep).map((x) => x.id)).toEqual(['l1']);
  });
});

describe('buildLaneIndex — invariant 3: root work belongs to the project node', () => {
  it('routes parentless work to the root lane', () => {
    expect(buildLaneIndex(TREE).get('r1')).toEqual({ laneId: ROOT_LANE_ID, crumb: null });
  });

  it('produces no root placement at all when every task lives in a phase', () => {
    const placements = [...buildLaneIndex(TREE.filter((x) => x.id !== 'r1')).values()];
    expect(placements.some((p) => p.laneId === ROOT_LANE_ID)).toBe(false);
  });
});

describe('collectLaneHeads', () => {
  it('returns top-level containers only, in board order', () => {
    expect(collectLaneHeads(TREE).map((x) => x.id)).toEqual(['p1', 'p2']);
  });

  it('does not promote a childless root task to a lane', () => {
    // The deleted workshop-mode branch. A childless row is a task until
    // `structure_role` lets someone say otherwise (#2946); promoting it made a
    // row's identity depend on which mode the viewer had toggled.
    expect(collectLaneHeads([t({ id: 'solo', name: 'New phase' })])).toEqual([]);
  });
});

describe('buildLaneIndex — hostile input', () => {
  it('terminates on a parentId cycle rather than hanging the board', () => {
    // The server's graph guard rejects this; a stale cache can still hold it.
    const cyclic: Task[] = [
      t({ id: 'x', name: 'X', parentId: 'y', isSummary: true }),
      t({ id: 'y', name: 'Y', parentId: 'x', isSummary: true }),
      t({ id: 'card', name: 'Card', parentId: 'x' }),
    ];
    expect(() => buildLaneIndex(cyclic)).not.toThrow();
    expect(buildLaneIndex(cyclic).has('card')).toBe(true);
  });

  it('stops at a parent that is not in the list', () => {
    const orphan: Task[] = [t({ id: 'o', name: 'Orphan', parentId: 'missing' })];
    expect(buildLaneIndex(orphan).get('o')).toEqual({ laneId: ROOT_LANE_ID, crumb: null });
  });
});
