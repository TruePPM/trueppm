import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import { computePlannedByPhase } from './plannedByPhase';

/** Minimal task stub — computePlannedByPhase only reads id/wbs/isSummary/sprintId. */
function t(id: string, wbs: string, extra: Partial<Task> = {}): Task {
  return { id, wbs, isSummary: false, sprintId: null, ...extra } as Task;
}

describe('computePlannedByPhase', () => {
  it('attributes sprint-assigned backlog to every ancestor phase', () => {
    const all = [
      t('p1', '1', { isSummary: true }),
      t('p1a', '1.2', { isSummary: true }),
      t('leaf', '1.2.3', { sprintId: 's1' }),
    ];
    const planned = all.filter((x) => x.sprintId);

    const map = computePlannedByPhase(planned, all);
    // Both ancestor phases (1 and 1.2) count the descendant.
    expect(map.get('p1')).toEqual({ count: 1, sprintIds: ['s1'] });
    expect(map.get('p1a')).toEqual({ count: 1, sprintIds: ['s1'] });
    // The leaf itself is never a phase.
    expect(map.get('leaf')).toBeUndefined();
  });

  it('sums counts and collects distinct sprint ids per phase', () => {
    const all = [
      t('p1', '1', { isSummary: true }),
      t('l1', '1.1', { sprintId: 's1' }),
      t('l2', '1.2', { sprintId: 's2' }),
      t('l3', '1.3', { sprintId: 's1' }),
    ];
    const planned = all.filter((x) => x.sprintId);

    const map = computePlannedByPhase(planned, all);
    const info = map.get('p1');
    expect(info?.count).toBe(3);
    // Distinct, first-seen order.
    expect(info?.sprintIds).toEqual(['s1', 's2']);
  });

  it('ignores planned tasks whose ancestor prefix has no summary row', () => {
    const all = [t('l1', '1.1', { sprintId: 's1' })]; // no '1' summary present
    const map = computePlannedByPhase([all[0]], all);
    expect(map.size).toBe(0);
  });

  it('never attributes a task to itself even when it is a summary', () => {
    // A summary task cannot be sprint-assigned backlog, but guard the walk anyway:
    // ancestors stop before the task's own full path.
    const all = [
      t('p1', '1', { isSummary: true }),
      t('l1', '1.1', { sprintId: 's1' }),
    ];
    const map = computePlannedByPhase([all[1]], all);
    expect(map.get('p1')?.count).toBe(1);
    expect(map.get('l1')).toBeUndefined();
  });

  it('returns an empty map when there is no planned work', () => {
    const all = [t('p1', '1', { isSummary: true }), t('l1', '1.1')];
    expect(computePlannedByPhase([], all).size).toBe(0);
  });
});
