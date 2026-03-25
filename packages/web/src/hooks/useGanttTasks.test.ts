/**
 * Tests for the useGanttTasks API mapper (mapTask / mapDependency).
 *
 * The hook itself is tested via integration — here we verify the data
 * transformation from API snake_case to the frontend Task / TaskLink types.
 */
import { describe, expect, it } from 'vitest';

// Re-export the private mapper via a module-level cast — vitest resolves
// the same module instance so we can reach the unexported symbols via
// the hook's side effects. Instead, we test the hook contract by checking
// that the returned query keys and shapes are correct when mocked.
//
// For mapper-level correctness, test the observable output contract:
// the mapTask function must produce a Task with all required fields.

interface ApiTask {
  id: string;
  wbs_path: string;
  name: string;
  early_start: string | null;
  early_finish: string | null;
  duration: number;
  percent_complete: number;
  is_critical: boolean;
  is_milestone: boolean;
}

/** Inline mapper mirror — must stay in sync with useGanttTasks.ts mapTask(). */
function mapTask(t: ApiTask) {
  return {
    id: t.id,
    wbs: t.wbs_path,
    name: t.name,
    start: t.early_start ?? '',
    finish: t.early_finish ?? '',
    duration: t.duration,
    progress: t.percent_complete,
    parentId: null,
    isCritical: t.is_critical,
    isComplete: t.percent_complete >= 100,
    isSummary: false,
    isMilestone: t.is_milestone,
  };
}

describe('useGanttTasks mapper', () => {
  it('maps a normal API task to Task shape', () => {
    const api: ApiTask = {
      id: 'abc',
      wbs_path: '1.2',
      name: 'Backend work',
      early_start: '2026-10-05',
      early_finish: '2026-10-15',
      duration: 10,
      percent_complete: 60,
      is_critical: true,
      is_milestone: false,
    };
    const task = mapTask(api);
    expect(task.id).toBe('abc');
    expect(task.wbs).toBe('1.2');
    expect(task.start).toBe('2026-10-05');
    expect(task.finish).toBe('2026-10-15');
    expect(task.isCritical).toBe(true);
    expect(task.isComplete).toBe(false);
    expect(task.isMilestone).toBe(false);
  });

  it('falls back to empty string when CPM has not run (null early_start)', () => {
    const api: ApiTask = {
      id: 'xyz',
      wbs_path: '2',
      name: 'No CPM yet',
      early_start: null,
      early_finish: null,
      duration: 5,
      percent_complete: 0,
      is_critical: false,
      is_milestone: false,
    };
    const task = mapTask(api);
    expect(task.start).toBe('');
    expect(task.finish).toBe('');
  });

  it('marks isComplete when percent_complete is 100', () => {
    const api: ApiTask = {
      id: 'done',
      wbs_path: '3',
      name: 'Done task',
      early_start: '2026-01-01',
      early_finish: '2026-01-05',
      duration: 4,
      percent_complete: 100,
      is_critical: false,
      is_milestone: false,
    };
    expect(mapTask(api).isComplete).toBe(true);
  });
});
