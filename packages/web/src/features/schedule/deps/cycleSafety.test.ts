import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import { FIXTURE_TASKS } from '@/fixtures/tasks';
import { dependsOn, ineligiblePredecessorIds, type CycleLink } from './cycleSafety';

function t(over: Partial<Task> & { id: string }): Task {
  return {
    ...FIXTURE_TASKS[0],
    parentId: null,
    isSummary: false,
    isMilestone: false,
    duration: 5,
    ...over,
  };
}

/**
 * 1 Mobilization
 *   1.1 Permits        (work)
 *   1.2 Survey         (work)
 *   1.3 Gate           (milestone — implicitly waits on 1.1 and 1.2)
 * 2 Install
 *   2.1 Cable pull     (work, explicitly after the gate)
 */
const TREE: Task[] = [
  t({ id: 'p1', name: 'Mobilization', isSummary: true }),
  t({ id: 'permits', name: 'Permits', parentId: 'p1' }),
  t({ id: 'survey', name: 'Survey', parentId: 'p1' }),
  t({ id: 'gate', name: 'Gate', parentId: 'p1', isMilestone: true, duration: 0 }),
  t({ id: 'p2', name: 'Install', isSummary: true }),
  t({ id: 'cable', name: 'Cable pull', parentId: 'p2' }),
];
const LINKS: CycleLink[] = [{ sourceId: 'gate', targetId: 'cable' }];

describe('dependsOn — explicit edges', () => {
  it('follows a direct link', () => {
    expect(dependsOn(byId('cable'), byId('gate'), TREE, LINKS)).toBe(true);
  });

  it('is directional', () => {
    expect(dependsOn(byId('gate'), byId('cable'), TREE, LINKS)).toBe(false);
  });
});

describe('dependsOn — the implicit edges a naive check misses', () => {
  it('knows a gate waits on the work in its own phase', () => {
    // No dependency row exists for this. The gate's date derives from the work
    // beside it, which is why walking only `allLinks` gets it wrong.
    expect(dependsOn(byId('gate'), byId('permits'), TREE, LINKS)).toBe(true);
  });

  it('does not make two gates in one phase block each other', () => {
    const twoGates: Task[] = [
      ...TREE,
      t({ id: 'gate2', name: 'Gate 2', parentId: 'p1', isMilestone: true, duration: 0 }),
    ];
    expect(dependsOn(byId('gate', twoGates), byId('gate2', twoGates), twoGates, LINKS)).toBe(false);
  });

  it('knows a phase waits on its children', () => {
    expect(dependsOn(byId('p1'), byId('permits'), TREE, LINKS)).toBe(true);
  });

  it('chains through a gate — the case the server rejects and the picker offered', () => {
    // cable --(link)--> gate --(implicit)--> permits.
    // So offering `cable` as a predecessor of `permits` would close a loop.
    expect(dependsOn(byId('cable'), byId('permits'), TREE, LINKS)).toBe(true);
  });

  it('terminates on a pre-existing cycle rather than hanging the picker', () => {
    const cyclic: CycleLink[] = [
      { sourceId: 'permits', targetId: 'survey' },
      { sourceId: 'survey', targetId: 'permits' },
    ];
    expect(() => dependsOn(byId('permits'), byId('cable'), TREE, cyclic)).not.toThrow();
  });
});

describe('ineligiblePredecessorIds', () => {
  it('excludes the row itself', () => {
    expect(ineligiblePredecessorIds(byId('permits'), TREE, LINKS).has('permits')).toBe(true);
  });

  it('excludes the row own subtree — a phase cannot wait on its own child', () => {
    const out = ineligiblePredecessorIds(byId('p1'), TREE, LINKS);
    expect(out.has('permits')).toBe(true);
    expect(out.has('gate')).toBe(true);
  });

  it('excludes a row that would close a loop through a gate', () => {
    // The whole point of the issue: this was offered, and the server refused it.
    expect(ineligiblePredecessorIds(byId('permits'), TREE, LINKS).has('cable')).toBe(true);
  });

  it('OFFERS a phase — waiting on a whole phase is the most common link there is', () => {
    const out = ineligiblePredecessorIds(byId('cable'), TREE, LINKS);
    expect(out.has('p1')).toBe(false);
  });

  it('offers an unrelated sibling', () => {
    expect(ineligiblePredecessorIds(byId('cable'), TREE, LINKS).has('survey')).toBe(false);
  });
});

function byId(id: string, from: Task[] = TREE): Task {
  const found = from.find((x) => x.id === id);
  if (!found) throw new Error(`no fixture task ${id}`);
  return found;
}
