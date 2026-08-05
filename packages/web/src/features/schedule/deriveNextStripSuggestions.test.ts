import { describe, expect, it } from 'vitest';
import type { Task, TaskLink } from '@/types';
import { deriveNextStripSuggestions } from './deriveNextStripSuggestions';

/** Minimal task stub — the function only reads a handful of fields. */
function t(id: string, wbs: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    wbs,
    isSummary: false,
    isMilestone: false,
    isUntouchedSeed: false,
    assignees: [],
    ...extra,
  } as Task;
}

function link(sourceId: string, targetId: string): Pick<TaskLink, 'sourceId' | 'targetId'> {
  return { sourceId, targetId };
}

describe('deriveNextStripSuggestions', () => {
  it('returns nothing for an empty schedule', () => {
    expect(deriveNextStripSuggestions([], [])).toEqual([]);
  });

  it('returns nothing when every seeded row has been touched', () => {
    const tasks = [
      t('l1', '1.1', { isUntouchedSeed: false }),
      t('m1', '1.2', { isMilestone: true, isUntouchedSeed: false }),
    ];
    expect(deriveNextStripSuggestions(tasks, [])).toEqual([]);
  });

  it('flags leaf seeded tasks with no assignee as unowned, singular-safe', () => {
    const tasks = [t('l1', '1.1', { isUntouchedSeed: true, assignees: [] })];
    const result = deriveNextStripSuggestions(tasks, []);
    expect(result).toEqual([{ id: 'unowned', count: 1, label: '1 task has no owner yet' }]);
  });

  it('excludes an owned seeded leaf from the unowned count', () => {
    const tasks = [
      t('l1', '1.1', {
        isUntouchedSeed: true,
        assignees: [{ userId: 'u1', name: 'A', units: 1 } as never],
      }),
    ];
    expect(deriveNextStripSuggestions(tasks, [])).toEqual([]);
  });

  it('excludes summary and milestone rows from the unowned count', () => {
    const tasks = [
      t('p1', '1', { isSummary: true, isUntouchedSeed: true, assignees: [] }),
      t('m1', '1.1', { isMilestone: true, isUntouchedSeed: true, assignees: [] }),
    ];
    // The milestone still counts toward unconfirmedGates, but not unowned.
    const result = deriveNextStripSuggestions(tasks, []);
    expect(result.find((s) => s.id === 'unowned')).toBeUndefined();
  });

  it('pluralizes unowned at 2+', () => {
    const tasks = [
      t('l1', '1.1', { isUntouchedSeed: true, assignees: [] }),
      t('l2', '1.2', { isUntouchedSeed: true, assignees: [] }),
    ];
    expect(deriveNextStripSuggestions(tasks, [])).toEqual([
      { id: 'unowned', count: 2, label: '2 tasks have no owner yet' },
    ]);
  });

  it('flags an untouched-seeded milestone as an unconfirmed gate', () => {
    const tasks = [t('m1', '1.1', { isMilestone: true, isUntouchedSeed: true })];
    expect(deriveNextStripSuggestions(tasks, [])).toEqual([
      { id: 'unconfirmedGates', count: 1, label: "1 milestone hasn't been confirmed" },
    ]);
  });

  it('does not flag a milestone a person has already touched', () => {
    const tasks = [t('m1', '1.1', { isMilestone: true, isUntouchedSeed: false })];
    expect(deriveNextStripSuggestions(tasks, [])).toEqual([]);
  });

  it('flags a top-level untouched-seeded phase with no dependency edges in its subtree', () => {
    const owned = [{ userId: 'u1', name: 'A', units: 1 } as never];
    const tasks = [
      t('p1', '1', { isSummary: true, isUntouchedSeed: true }),
      t('l1', '1.1', { isUntouchedSeed: true, assignees: owned }),
      t('l2', '1.2', { isUntouchedSeed: true, assignees: owned }),
    ];
    // No links at all — the phase's subtree is fully disconnected. Both leaves
    // are owned so only the undeclaredBranches signal fires here.
    const result = deriveNextStripSuggestions(tasks, []);
    expect(result).toEqual([
      {
        id: 'undeclaredBranches',
        count: 1,
        label: "1 phase isn't connected to the rest of the plan",
      },
    ]);
  });

  it('excludes a phase whose subtree carries at least one dependency edge', () => {
    const tasks = [
      t('p1', '1', { isSummary: true, isUntouchedSeed: true }),
      t('l1', '1.1', { isUntouchedSeed: true }),
      t('l2', '1.2', { isUntouchedSeed: true }),
      t('p2', '2', { isSummary: true, isUntouchedSeed: true }),
      t('l3', '2.1', { isUntouchedSeed: true }),
    ];
    // l1 -> l3 links phase 1's subtree to something outside it; phase 2's
    // subtree (l3) is linked directly. Neither phase is "undeclared".
    const result = deriveNextStripSuggestions(tasks, [link('l1', 'l3')]);
    expect(result.find((s) => s.id === 'undeclaredBranches')).toBeUndefined();
  });

  it('does not flag a non-top-level (nested) summary as a branch', () => {
    const tasks = [
      t('p1', '1', { isSummary: true, isUntouchedSeed: true }),
      t('p1a', '1.1', { isSummary: true, isUntouchedSeed: true }),
      t('l1', '1.1.1', { isUntouchedSeed: true }),
    ];
    // p1's subtree includes p1a and l1, none linked — p1 is undeclared, but
    // p1a (WBS depth 2) is never independently evaluated.
    const result = deriveNextStripSuggestions(tasks, []);
    expect(result.find((s) => s.id === 'undeclaredBranches')).toEqual({
      id: 'undeclaredBranches',
      count: 1,
      label: "1 phase isn't connected to the rest of the plan",
    });
  });

  it('does not flag a phase that has since been touched', () => {
    const owned = [{ userId: 'u1', name: 'A', units: 1 } as never];
    const tasks = [
      t('p1', '1', { isSummary: true, isUntouchedSeed: false }),
      t('l1', '1.1', { isUntouchedSeed: true, assignees: owned }),
    ];
    expect(deriveNextStripSuggestions(tasks, [])).toEqual([]);
  });

  it('orders suggestions unowned -> unconfirmedGates -> undeclaredBranches regardless of counts', () => {
    const tasks = [
      t('p1', '1', { isSummary: true, isUntouchedSeed: true }),
      t('l1', '1.1', { isUntouchedSeed: true, assignees: [] }),
      t('m1', '2', { isMilestone: true, isUntouchedSeed: true }),
    ];
    const result = deriveNextStripSuggestions(tasks, []);
    expect(result.map((s) => s.id)).toEqual(['unowned', 'unconfirmedGates', 'undeclaredBranches']);
  });
});
