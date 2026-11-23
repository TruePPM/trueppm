import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import type { BoardColumnDef } from '@/hooks/useBoardConfig';
import {
  applyFilter,
  cardChips,
  columnHeads,
  groupIntoLanes,
  splitDone,
  summarizeLane,
} from './board2Model';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    wbs: '1',
    name: over.id,
    start: '2026-03-02',
    finish: '2026-03-06',
    duration: 5,
    parentId: null,
    isCritical: false,
    isSummary: false,
    status: 'NOT_STARTED',
    assignees: [],
    ...over,
  } as Task;
}

const COLS = [
  { status: 'NOT_STARTED', label: 'To Do', wipLimit: null },
  { status: 'IN_PROGRESS', label: 'In Progress', wipLimit: 2 },
] as BoardColumnDef[];

describe('groupIntoLanes', () => {
  const phase = task({ id: 'p1', name: 'Discovery', isSummary: true, isPhase: true });
  const a = task({
    id: 'a',
    parentId: 'p1',
    isCritical: true,
    start: '2026-03-02',
    finish: '2026-03-04',
  });
  const b = task({ id: 'b', parentId: 'p1', start: '2026-03-03', finish: '2026-03-10' });
  const root = task({ id: 'r', parentId: null });

  it('groups cards under their phase and the project lane, never listing a container as a card', () => {
    const lanes = groupIntoLanes([phase, a, b, root], 'Atlas');
    expect(lanes.map((l) => l.name)).toEqual(['Discovery', 'Atlas']);
    expect(lanes[0].tasks.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('keeps the phase lanes when a filter narrows the cards', () => {
    const lanes = groupIntoLanes([phase, a, b, root], 'Atlas', true, (t) => t.id === 'a');
    expect(lanes.map((l) => l.name)).toEqual(['Discovery']);
    expect(lanes[0].tasks.map((t) => t.id)).toEqual(['a']);
  });

  it('flattens to one lane when lanes are off', () => {
    const lanes = groupIntoLanes([phase, a, b, root], 'Atlas', false);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].tasks).toHaveLength(3);
  });

  it('returns no lanes for no cards', () => {
    expect(groupIntoLanes([], 'Atlas')).toEqual([]);
  });

  it('summarizes count, critical count and the date span', () => {
    expect(summarizeLane([a, b])).toEqual({
      count: 2,
      critical: 1,
      start: '2026-03-02',
      finish: '2026-03-10',
    });
    expect(summarizeLane([])).toEqual({ count: 0, critical: 0, start: null, finish: null });
  });
});

describe('columnHeads WIP flagging', () => {
  it('flags over, at and under the limit', () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => task({ id: `t${n}-${i}`, status: 'IN_PROGRESS' }));
    expect(columnHeads(COLS, mk(3))[1]).toMatchObject({ count: 3, wip: 'over', wipLimit: 2 });
    expect(columnHeads(COLS, mk(2))[1].wip).toBe('at');
    expect(columnHeads(COLS, mk(1))[1].wip).toBe('under');
    expect(columnHeads(COLS, mk(5))[0].wip).toBe('none');
  });
});

describe('cardChips', () => {
  it('derives critical, blocked and near-critical chips', () => {
    expect(cardChips(task({ id: 'x', isCritical: true }))).toEqual([{ kind: 'critical' }]);
    expect(cardChips(task({ id: 'x', blockedReason: 'Waiting on legal' }))).toEqual([
      { kind: 'blocked', reason: 'Waiting on legal' },
    ]);
    expect(cardChips(task({ id: 'x', totalFloat: 3 }))).toEqual([{ kind: 'near', floatDays: 3 }]);
    expect(cardChips(task({ id: 'x', totalFloat: 20 }))).toEqual([]);
    // A critical card is not also near-critical.
    expect(cardChips(task({ id: 'x', isCritical: true, totalFloat: 0 }))).toEqual([
      { kind: 'critical' },
    ]);
  });
});

describe('filter and Done folding', () => {
  it('narrows to critical and blocked cards', () => {
    const ts = [
      task({ id: 'c', isCritical: true }),
      task({ id: 'b', isBlocked: true }),
      task({ id: 'n' }),
    ];
    expect(applyFilter(ts, { criticalOnly: true, blockedOnly: false }).map((t) => t.id)).toEqual([
      'c',
    ]);
    expect(applyFilter(ts, { criticalOnly: false, blockedOnly: true }).map((t) => t.id)).toEqual([
      'b',
    ]);
    expect(applyFilter(ts, { criticalOnly: false, blockedOnly: false })).toHaveLength(3);
  });

  it('shows two done cards then folds the rest', () => {
    expect(splitDone([1, 2, 3, 4, 5], false)).toEqual({ shown: [1, 2], hidden: 3 });
    expect(splitDone([1, 2, 3], true).hidden).toBe(0);
    expect(splitDone([1, 2], false).hidden).toBe(0);
  });
});
