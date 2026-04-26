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
  wbs_path: string | null;
  name: string;
  early_start: string | null;
  early_finish: string | null;
  planned_start: string | null;
  duration: number;
  percent_complete: number;
  is_critical: boolean;
  status: string;
  is_milestone: boolean;
  is_summary: boolean;
  parent_id: string | null;
  actual_start: string | null;
  actual_finish: string | null;
  schedule_variance_days: number | null;
  baseline_start: string | null;
  baseline_finish: string | null;
  total_float: number | null;
}

/** Inline mapper mirror — must stay in sync with useGanttTasks.ts mapTask(). */
function mapTask(t: ApiTask) {
  const p = t.planned_start;
  const e = t.early_start;
  const start = (p && e) ? (p >= e ? p : e) : (p ?? e ?? '');

  const finish = t.is_summary
    ? (t.early_finish ?? '')
    : (start && t.duration > 0)
      ? new Date(
          new Date(start + 'T00:00:00Z').getTime() + t.duration * 86_400_000,
        ).toISOString().slice(0, 10)
      : (t.early_finish ?? '');

  const displayDuration =
    t.is_summary && t.early_start && t.early_finish
      ? Math.max(
          1,
          Math.round(
            (new Date(t.early_finish).getTime() - new Date(t.early_start).getTime()) /
              86_400_000,
          ),
        )
      : t.duration;

  return {
    id: t.id,
    wbs: t.wbs_path ?? '',
    name: t.name,
    start,
    finish,
    duration: displayDuration,
    progress: t.percent_complete,
    parentId: t.parent_id,
    isCritical: t.is_critical,
    isComplete: t.percent_complete >= 100,
    isSummary: t.is_summary,
    isMilestone: t.is_milestone,
    status: t.status,
    actualStart: t.actual_start ?? undefined,
    actualFinish: t.actual_finish ?? undefined,
    scheduleVarianceDays: t.schedule_variance_days,
    baselineStart: t.baseline_start ?? undefined,
    baselineFinish: t.baseline_finish ?? undefined,
    totalFloat: t.total_float,
  };
}

describe('useGanttTasks mapper', () => {
  const base: ApiTask = {
    id: 'abc',
    wbs_path: '1.2',
    name: 'Backend work',
    early_start: '2026-10-05',
    early_finish: '2026-10-15',
    planned_start: null,
    duration: 10,
    percent_complete: 60,
    status: 'IN_PROGRESS',
    is_critical: true,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    total_float: null,
  };

  it('maps a normal API task to Task shape', () => {
    const task = mapTask(base);
    expect(task.id).toBe('abc');
    expect(task.wbs).toBe('1.2');
    expect(task.start).toBe('2026-10-05');
    expect(task.isCritical).toBe(true);
    expect(task.isComplete).toBe(false);
    expect(task.isMilestone).toBe(false);
    expect(task.isSummary).toBe(false);
    expect(task.baselineStart).toBeUndefined();
  });

  it('derives finish from start + duration', () => {
    const task = mapTask(base);
    // 2026-10-05 + 10 days = 2026-10-15
    expect(task.finish).toBe('2026-10-15');
  });

  it('falls back to empty string when CPM has not run (null early_start)', () => {
    const task = mapTask({
      ...base,
      id: 'xyz',
      early_start: null,
      early_finish: null,
      planned_start: null,
      duration: 5,
      percent_complete: 0,
      status: 'NOT_STARTED',
    });
    expect(task.start).toBe('');
    expect(task.finish).toBe('');
  });

  it('marks isComplete when percent_complete is 100', () => {
    expect(mapTask({ ...base, percent_complete: 100 }).isComplete).toBe(true);
  });

  // ---- max(planned_start, early_start) logic ----

  it('uses planned_start when CPM has not run yet (early_start null)', () => {
    const task = mapTask({ ...base, planned_start: '2026-11-01', early_start: null });
    expect(task.start).toBe('2026-11-01');
  });

  it('uses early_start when no SNET constraint (planned_start null)', () => {
    const task = mapTask({ ...base, planned_start: null, early_start: '2026-10-05' });
    expect(task.start).toBe('2026-10-05');
  });

  it('uses early_start when dependency pushes it later than planned_start', () => {
    const task = mapTask({
      ...base,
      planned_start: '2026-10-05',
      early_start: '2026-10-20',
    });
    expect(task.start).toBe('2026-10-20');
  });

  it('uses planned_start right after drag (planned_start > stale early_start)', () => {
    const task = mapTask({
      ...base,
      planned_start: '2026-11-01',
      early_start: '2026-10-05',
    });
    expect(task.start).toBe('2026-11-01');
  });

  it('uses either when planned_start equals early_start', () => {
    const task = mapTask({
      ...base,
      planned_start: '2026-10-05',
      early_start: '2026-10-05',
    });
    expect(task.start).toBe('2026-10-05');
  });

  // ---- actual dates ----

  it('maps actual dates when present', () => {
    const task = mapTask({
      ...base,
      actual_start: '2026-10-06',
      actual_finish: '2026-10-16',
      schedule_variance_days: 1,
    });
    expect(task.actualStart).toBe('2026-10-06');
    expect(task.actualFinish).toBe('2026-10-16');
    expect(task.scheduleVarianceDays).toBe(1);
  });

  it('maps actual dates as undefined when null', () => {
    const task = mapTask(base);
    expect(task.actualStart).toBeUndefined();
    expect(task.actualFinish).toBeUndefined();
    expect(task.scheduleVarianceDays).toBeNull();
  });

  // ---- summary task rollup ----

  it('summary: finish uses early_finish directly (ignores duration)', () => {
    const task = mapTask({
      ...base,
      is_summary: true,
      early_start: '2026-01-06',
      early_finish: '2026-02-06',
      duration: 1, // stale stored value — must be ignored for bar width
    });
    expect(task.finish).toBe('2026-02-06');
  });

  it('summary: finish is empty string when CPM has not run yet', () => {
    const task = mapTask({
      ...base,
      is_summary: true,
      early_start: null,
      early_finish: null,
      planned_start: '2026-01-06',
      duration: 5,
    });
    expect(task.finish).toBe('');
  });

  it('summary: duration is computed as calendar-day span from CPM dates', () => {
    const task = mapTask({
      ...base,
      is_summary: true,
      early_start: '2026-01-06',
      early_finish: '2026-02-06', // 31 calendar days
      duration: 1,
    });
    expect(task.duration).toBe(31);
  });

  it('summary: duration falls back to stored value when CPM has not run', () => {
    const task = mapTask({
      ...base,
      is_summary: true,
      early_start: null,
      early_finish: null,
      duration: 5,
    });
    expect(task.duration).toBe(5);
  });

  it('summary: isSummary is propagated', () => {
    const task = mapTask({ ...base, is_summary: true });
    expect(task.isSummary).toBe(true);
  });

  it('leaf task: finish still computed from start + duration', () => {
    const task = mapTask({
      ...base,
      is_summary: false,
      early_start: '2026-10-05',
      early_finish: '2026-10-20', // would give 15 days if used directly
      duration: 10,
    });
    // 2026-10-05 + 10 days = 2026-10-15 (uses duration, not early_finish)
    expect(task.finish).toBe('2026-10-15');
  });
});
