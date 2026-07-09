import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import { isPhaseTask } from './isPhaseTask';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    wbs: '1',
    name: 'Task',
    start: '2026-01-01',
    finish: '2026-01-02',
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

describe('isPhaseTask', () => {
  it('trusts the server-computed isPhase field when present (true)', () => {
    const task = makeTask({ id: 'p1', isPhase: true });
    // No siblings at all — the server verdict wins over the empty derivation.
    expect(isPhaseTask(task, [task])).toBe(true);
  });

  it('trusts the server-computed isPhase field when present (false)', () => {
    const parent = makeTask({ id: 'p1', isPhase: false });
    const child = makeTask({ id: 'c1', parentId: 'p1' });
    // Even though a structural child exists, an explicit `false` from the
    // server is authoritative — never re-derive when the field is present.
    expect(isPhaseTask(parent, [parent, child])).toBe(false);
  });

  it('falls back to the client-side predicate when isPhase is absent: non-subtask task with a structural child is a phase', () => {
    const parent = makeTask({ id: 'p1' });
    const child = makeTask({ id: 'c1', parentId: 'p1', isSubtask: false });
    expect(isPhaseTask(parent, [parent, child])).toBe(true);
  });

  it('a childless task is not a phase (phase-in-waiting)', () => {
    const lone = makeTask({ id: 'p1' });
    expect(isPhaseTask(lone, [lone])).toBe(false);
  });

  it('a leaf task with only subtask children is NOT a phase (leaf-with-subtasks, distinct from a phase)', () => {
    const parent = makeTask({ id: 'p1' });
    const subtask = makeTask({ id: 's1', parentId: 'p1', isSubtask: true });
    expect(isPhaseTask(parent, [parent, subtask])).toBe(false);
  });

  it('a subtask can never itself be a phase', () => {
    const parent = makeTask({ id: 'p1' });
    const subtask = makeTask({ id: 's1', parentId: 'p1', isSubtask: true });
    // Even if (hypothetically) something reported a child of the subtask,
    // depth is capped at 1 and the subtask itself is excluded up front.
    expect(isPhaseTask(subtask, [parent, subtask])).toBe(false);
  });

  it('a task with both a structural child and a subtask child is a phase', () => {
    const parent = makeTask({ id: 'p1' });
    const structural = makeTask({ id: 'c1', parentId: 'p1', isSubtask: false });
    const subtask = makeTask({ id: 's1', parentId: 'p1', isSubtask: true });
    expect(isPhaseTask(parent, [parent, structural, subtask])).toBe(true);
  });
});
