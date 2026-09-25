import { describe, it, expect } from 'vitest';
import type { Task } from '@/types';
import { behindByPoints, expectedProgress, pickDemoHintTarget } from './demoHintTarget';

const TODAY = '2026-07-15';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    name: over.id,
    start: '2026-07-01',
    finish: '2026-07-31',
    progress: 0,
    isCritical: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    assignees: [],
    ...over,
  } as unknown as Task;
}

describe('expectedProgress', () => {
  it('is the straight-line share of the window that has elapsed', () => {
    // Jul 1 → Jul 31, today Jul 15: 14 of 30 days.
    expect(expectedProgress(task({ id: 'a' }), TODAY)).toBeCloseTo((14 / 30) * 100, 5);
  });

  it('clamps outside the window rather than extrapolating', () => {
    expect(expectedProgress(task({ id: 'a', start: '2026-08-01', finish: '2026-08-10' }), TODAY)).toBe(0);
    expect(expectedProgress(task({ id: 'a', start: '2026-05-01', finish: '2026-05-10' }), TODAY)).toBe(100);
  });

  it('has no answer for a row nobody can drag two days to any effect', () => {
    expect(expectedProgress(task({ id: 'm', isMilestone: true }), TODAY)).toBeNull();
    expect(expectedProgress(task({ id: 's', isSummary: true }), TODAY)).toBeNull();
    expect(expectedProgress(task({ id: 'z', start: '2026-07-10', finish: '2026-07-10' }), TODAY)).toBeNull();
  });
});

describe('behindByPoints', () => {
  it('is positive when the work is behind its plan', () => {
    const t = task({ id: 'a', progress: 40 });
    // Expected ~46.7% at Jul 15 against 40% done.
    expect(behindByPoints(t, TODAY)).toBeCloseTo((14 / 30) * 100 - 40, 5);
  });

  it('is negative when the work is ahead', () => {
    expect(behindByPoints(task({ id: 'a', progress: 90 }), TODAY)).toBeLessThan(0);
  });
});

describe('pickDemoHintTarget', () => {
  it('prefers the critical task that is furthest behind', () => {
    const tasks = [
      task({ id: 'off-cp', name: 'Delta sync', progress: 5, isCritical: false }),
      task({ id: 'cp-ahead', name: 'Dry-run migration', progress: 90, isCritical: true }),
      task({ id: 'cp-behind', name: 'Performance tuning', progress: 40, isCritical: true }),
    ];
    expect(pickDemoHintTarget(tasks, TODAY)).toEqual({
      id: 'cp-behind',
      name: 'Performance tuning',
    });
  });

  it('never picks a task with float, however far behind it is', () => {
    // The hint promises "watch the finish date move". Dragging a task with
    // float moves nothing but that task, which teaches the opposite.
    const tasks = [task({ id: 'slack', name: 'Rollback drill', progress: 0, isCritical: false })];
    expect(pickDemoHintTarget(tasks, TODAY)).toBeNull();
  });

  it('returns null when nothing is behind, rather than pointing at an arbitrary row', () => {
    const tasks = [
      task({ id: 'a', progress: 100, isCritical: true }),
      task({ id: 'b', progress: 95, isCritical: true }),
    ];
    expect(pickDemoHintTarget(tasks, TODAY)).toBeNull();
  });

  it('ignores summaries and milestones even when they are critical', () => {
    const tasks = [
      task({ id: 'phase', progress: 0, isCritical: true, isSummary: true }),
      task({ id: 'gate', progress: 0, isCritical: true, isMilestone: true }),
    ];
    expect(pickDemoHintTarget(tasks, TODAY)).toBeNull();
  });

  it('is stable across re-renders when two rows are equally behind', () => {
    const tasks = [
      task({ id: 'bbb', name: 'B', progress: 10, isCritical: true }),
      task({ id: 'aaa', name: 'A', progress: 10, isCritical: true }),
    ];
    const first = pickDemoHintTarget(tasks, TODAY);
    const second = pickDemoHintTarget([...tasks].reverse(), TODAY);
    expect(first).toEqual(second);
    expect(first?.id).toBe('aaa');
  });
});
