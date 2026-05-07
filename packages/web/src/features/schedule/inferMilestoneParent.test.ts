import { describe, expect, it } from 'vitest';
import { inferNearestSummaryParent } from './inferMilestoneParent';
import type { Task } from '@/types';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    wbs: id,
    name: id,
    start: '2026-04-01',
    finish: '2026-04-05',
    duration: 1,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

describe('inferNearestSummaryParent', () => {
  it('returns null when no row is focused', () => {
    const tasks = [task('a', { isSummary: true }), task('b'), task('c')];
    expect(inferNearestSummaryParent(null, tasks)).toBeNull();
  });

  it('returns null when there are no visible tasks', () => {
    expect(inferNearestSummaryParent('a', [])).toBeNull();
  });

  it('returns null when no summary exists above the focused row', () => {
    const tasks = [task('a'), task('b'), task('c')];
    expect(inferNearestSummaryParent('c', tasks)).toBeNull();
  });

  it('returns the immediately preceding summary id', () => {
    const tasks = [task('phase1', { isSummary: true }), task('a'), task('b')];
    expect(inferNearestSummaryParent('b', tasks)).toBe('phase1');
  });

  it('skips non-summary tasks between focus and the nearest ancestor', () => {
    const tasks = [
      task('phaseA', { isSummary: true }),
      task('a'),
      task('phaseB', { isSummary: true }),
      task('b'),
      task('c'),
    ];
    expect(inferNearestSummaryParent('c', tasks)).toBe('phaseB');
  });

  it('returns the focused row id itself if it is a summary', () => {
    const tasks = [task('phase1', { isSummary: true }), task('a')];
    expect(inferNearestSummaryParent('phase1', tasks)).toBe('phase1');
  });

  it('returns null when focused id is not in the visible list', () => {
    const tasks = [task('a', { isSummary: true })];
    expect(inferNearestSummaryParent('does-not-exist', tasks)).toBeNull();
  });
});
