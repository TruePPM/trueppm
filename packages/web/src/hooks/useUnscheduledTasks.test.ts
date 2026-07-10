import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useUnscheduledTasks } from './useUnscheduledTasks';
import type { Task, TaskStatus } from '@/types';

function t(overrides: Partial<Task> & { id: string }): Task {
  return {
    name: 'Task',
    // `start` is what CPM computed (almost always non-empty in production); the
    // gutter filter intentionally ignores it. `plannedStart: null` is the
    // signal that the PM has not committed a date.
    start: '2026-04-01',
    finish: '2026-04-15',
    plannedStart: null,
    duration: 5,
    progress: 0,
    isSummary: false,
    isMilestone: false,
    isCritical: false,
    isComplete: false,
    parentId: null,
    wbs: '1',
    status: 'NOT_STARTED' as TaskStatus,
    assignees: [],
    sprintId: null,
    ...overrides,
  } as unknown as Task;
}

describe('useUnscheduledTasks', () => {
  it('includes NOT_STARTED tasks with no PM-committed start and no sprint', () => {
    const tasks = [t({ id: 'u1', status: 'NOT_STARTED', plannedStart: null })];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current.map((x) => x.id)).toEqual(['u1']);
  });

  it('includes NOT_STARTED tasks even when CPM has set a `start` (early_start)', () => {
    // In production a NOT_STARTED card promoted from BACKLOG immediately gets a
    // CPM-computed `early_start`. The gutter must still surface it until the PM
    // commits a planned date.
    const tasks = [
      t({ id: 'u1', status: 'NOT_STARTED', start: '2026-04-01', plannedStart: null }),
    ];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current.map((x) => x.id)).toEqual(['u1']);
  });

  it('includes BACKLOG ideas without a PM-committed start (issue #332)', () => {
    // BACKLOG cards with no plannedStart used to be excluded as "pre-planning"
    // but #332 reclassifies them: CPM gives them an early_start, so the
    // Schedule view was rendering them as scheduled bars and the Unscheduled
    // tray claimed "all tasks have planned dates" — both wrong. The gutter
    // is the correct surface for both NOT_STARTED and BACKLOG without a
    // committed date.
    const tasks = [
      t({ id: 'b1', status: 'BACKLOG', plannedStart: null }),
      t({ id: 'n1', status: 'NOT_STARTED', plannedStart: null }),
    ];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current.map((x) => x.id).sort()).toEqual(['b1', 'n1']);
  });

  it('excludes BACKLOG tasks with a PM-committed planned start', () => {
    // A backlog card the PM has committed to (via plannedStart) is scheduled
    // — the bar renders on the timeline and it must not show up in the gutter.
    const tasks = [t({ id: 'b1', status: 'BACKLOG', plannedStart: '2026-04-06' })];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current).toHaveLength(0);
  });

  it('excludes ON_HOLD (legacy column not surfaced as unscheduled)', () => {
    const tasks = [t({ id: 'h1', status: 'ON_HOLD', plannedStart: null })];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current).toHaveLength(0);
  });

  it('excludes IN_PROGRESS / REVIEW / COMPLETE — data integrity, not "needs scheduling"', () => {
    const tasks = [
      t({ id: 'p1', status: 'IN_PROGRESS', plannedStart: null }),
      t({ id: 'r1', status: 'REVIEW', plannedStart: null }),
      t({ id: 'c1', status: 'COMPLETE', plannedStart: null }),
    ];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current).toHaveLength(0);
  });

  it('excludes NOT_STARTED tasks already assigned to a sprint', () => {
    // A sprint-assigned NOT_STARTED task is committed to its sprint and floors
    // to the sprint window via the ADR-0168 CPM floor, so it renders as a real
    // bar on the timeline — it is not "unscheduled".
    const tasks = [
      t({ id: 'free', status: 'NOT_STARTED', plannedStart: null, sprintId: null }),
      t({
        id: 'committed',
        status: 'NOT_STARTED',
        plannedStart: null,
        sprintId: 'sprint-uuid',
      }),
    ];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current.map((x) => x.id)).toEqual(['free']);
  });

  it('includes BACKLOG tasks assigned to a sprint (#1790)', () => {
    // A sprint-assigned BACKLOG task is excluded from CPM entirely (uncommitted
    // work must never drive the critical path), so it has no early_start and,
    // pre-fix, stranded at the project origin. It belongs in the gutter under
    // its target sprint (read-only). Its sprint-assigned NOT_STARTED sibling,
    // which floors to the sprint window, must stay OUT of the gutter.
    const tasks = [
      t({ id: 'sprint-backlog', status: 'BACKLOG', plannedStart: null, sprintId: 'sprint-3' }),
      t({ id: 'sprint-todo', status: 'NOT_STARTED', plannedStart: null, sprintId: 'sprint-3' }),
    ];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current.map((x) => x.id)).toEqual(['sprint-backlog']);
  });

  it('excludes sprint-assigned BACKLOG once the PM commits a planned start', () => {
    const tasks = [
      t({ id: 'sb', status: 'BACKLOG', plannedStart: '2026-04-06', sprintId: 'sprint-3' }),
    ];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current).toHaveLength(0);
  });

  it('excludes summary tasks even when otherwise eligible', () => {
    const tasks = [
      t({ id: 'leaf', status: 'NOT_STARTED', plannedStart: null }),
      t({ id: 'summary', status: 'NOT_STARTED', plannedStart: null, isSummary: true }),
    ];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current.map((x) => x.id)).toEqual(['leaf']);
  });

  it('excludes NOT_STARTED tasks with a PM-committed planned start', () => {
    const tasks = [t({ id: 's1', status: 'NOT_STARTED', plannedStart: '2026-04-06' })];
    const { result } = renderHook(() => useUnscheduledTasks(tasks));
    expect(result.current).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    const { result } = renderHook(() => useUnscheduledTasks([]));
    expect(result.current).toHaveLength(0);
  });
});
