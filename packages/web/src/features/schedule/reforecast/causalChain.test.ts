import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import { FIXTURE_TASKS } from '@/fixtures/tasks';
import { orderByCausalChain, summarizeCausalChain, type ChainLink } from './causalChain';

function t(id: string, name: string): Task {
  return { ...FIXTURE_TASKS[0], id, name };
}

/** permits → survey → power, plus an unrelated row. */
const TASKS = [
  t('permits', 'Site access permits'),
  t('survey', 'Lay-down survey'),
  t('power', 'Temporary power'),
  t('solo', 'Insurance certificate'),
];
const LINKS: ChainLink[] = [
  { sourceId: 'permits', targetId: 'survey' },
  { sourceId: 'survey', targetId: 'power' },
];

const moved = (...ids: string[]) =>
  ids.map((id) => ({ taskId: id, taskName: TASKS.find((x) => x.id === id)!.name }));

describe('orderByCausalChain', () => {
  it('names the driver of a row that was pushed', () => {
    const rows = orderByCausalChain(moved('permits', 'survey'), LINKS, TASKS);
    const survey = rows.find((r) => r.taskId === 'survey')!;
    expect(survey.driverId).toBe('permits');
    expect(survey.driverName).toBe('Site access permits');
  });

  it('leaves a row that moved on its own account without a driver', () => {
    // These are the interesting rows — the causes, not the dominoes.
    const rows = orderByCausalChain(moved('permits', 'survey'), LINKS, TASKS);
    expect(rows.find((r) => r.taskId === 'permits')!.driverId).toBeNull();
  });

  it('does not attribute to a predecessor that did NOT move', () => {
    // survey moved; permits did not. Nothing upstream changed, so survey moved
    // for its own reason — blaming a stationary predecessor would be a lie.
    const rows = orderByCausalChain(moved('survey'), LINKS, TASKS);
    expect(rows[0].driverId).toBeNull();
  });

  it('orders causes before consequences', () => {
    const rows = orderByCausalChain(moved('power', 'survey', 'permits'), LINKS, TASKS);
    expect(rows.map((r) => r.taskId)).toEqual(['permits', 'survey', 'power']);
  });

  it('names the EARLIEST mover in a chain, not the nearest domino', () => {
    // power's immediate predecessor is survey, but permits started it. A planner
    // wants the cause.
    const rows = orderByCausalChain(moved('permits', 'survey', 'power'), LINKS, TASKS);
    const power = rows.find((r) => r.taskId === 'power')!;
    expect(power.depth).toBe(2);
    expect(rows.find((r) => r.taskId === 'survey')!.driverId).toBe('permits');
  });

  it('is stable by name within a depth, so the list does not reshuffle', () => {
    const a = orderByCausalChain(moved('solo', 'permits'), LINKS, TASKS);
    const b = orderByCausalChain(moved('permits', 'solo'), LINKS, TASKS);
    expect(a.map((r) => r.taskId)).toEqual(b.map((r) => r.taskId));
  });

  it('terminates on a stale-cache cycle rather than hanging', () => {
    const cyclic: ChainLink[] = [
      { sourceId: 'permits', targetId: 'survey' },
      { sourceId: 'survey', targetId: 'permits' },
    ];
    expect(() => orderByCausalChain(moved('permits', 'survey'), cyclic, TASKS)).not.toThrow();
  });

  it('handles an empty move set', () => {
    expect(orderByCausalChain([], LINKS, TASKS)).toEqual([]);
  });
});

describe('summarizeCausalChain — the distinction a flat list destroys', () => {
  it('separates causes from consequences', () => {
    // "12 dates changed" is alarming and uninformative. This is actionable.
    const rows = orderByCausalChain(moved('permits', 'survey', 'power'), LINKS, TASKS);
    expect(summarizeCausalChain(rows)).toBe('1 change moved 2 other dates.');
  });

  it('says so when moves are genuinely independent', () => {
    const rows = orderByCausalChain(moved('permits', 'solo'), LINKS, TASKS);
    expect(summarizeCausalChain(rows)).toBe('2 dates changed independently.');
  });

  it('singularizes a lone change', () => {
    expect(summarizeCausalChain(orderByCausalChain(moved('solo'), LINKS, TASKS))).toBe(
      '1 date changed.',
    );
  });

  it('says nothing dramatic when nothing moved', () => {
    expect(summarizeCausalChain([])).toBe('No dates changed.');
  });
});
