import { describe, it, expect } from 'vitest';
import type { MyWorkTask } from '@/hooks/useMyWork';
import { assignedTasks, myWorkTaskMeta, zeroRowCandidates } from './assignedTasks';
import { buildWeekRows, type WeeklyEntry } from './weekModel';

function task(id: string, extra: Partial<MyWorkTask> = {}): MyWorkTask {
  return {
    id,
    short_id: id.toUpperCase(),
    name: `Task ${id}`,
    project_id: 'p1',
    project_name: 'Web',
    status: 'IN_PROGRESS',
    due: null,
    scheduled_start: null,
    scheduled_finish: null,
    ...extra,
  } as MyWorkTask;
}

// Week of Mon 2026-06-15 .. Sun 2026-06-21; "today" is the Friday of that week.
const MONDAY = '2026-06-15';
const TODAY = '2026-06-19';

function span(start: string | null, finish: string | null): Partial<MyWorkTask> {
  return { scheduled_start: start, scheduled_finish: finish };
}

describe('zeroRowCandidates (#4766, #4783)', () => {
  it('excludes a completed task even when its span covers the week', () => {
    const done = task('a', { status: 'COMPLETE', ...span(MONDAY, '2026-06-17') });
    expect(zeroRowCandidates([done], MONDAY, TODAY)).toEqual([]);
  });

  it('keeps an open task whose span overlaps the week, at either edge', () => {
    const inside = task('a', span('2026-06-16', '2026-06-17'));
    const straddlesStart = task('b', span('2026-06-01', MONDAY));
    const straddlesEnd = task('c', span('2026-06-21', '2026-07-30'));
    const covers = task('d', span('2026-05-01', '2026-08-01'));
    const tasks = [inside, straddlesStart, straddlesEnd, covers];
    expect(zeroRowCandidates(tasks, MONDAY, TODAY)).toEqual(tasks);
  });

  it('drops an open task scheduled entirely after the week', () => {
    const later = task('a', span('2026-06-22', '2026-06-30'));
    expect(zeroRowCandidates([later], MONDAY, TODAY)).toEqual([]);
  });

  it('keeps an overdue open task in the current week — late work is still current', () => {
    const overdue = task('a', span('2026-05-01', '2026-05-15'));
    expect(zeroRowCandidates([overdue], MONDAY, TODAY)).toEqual([overdue]);
  });

  it('does not carry an overdue task into a future week', () => {
    const overdue = task('a', span('2026-05-01', '2026-05-15'));
    expect(zeroRowCandidates([overdue], '2026-06-22', TODAY)).toEqual([]);
  });

  it('shows overdue work in every week from its span through today, never before it', () => {
    // Viewing the week of 2026-05-25 with a span that ended 2026-05-15: overdue work runs
    // through today, so it is current in every week between its scheduled finish and today.
    const overdue = task('a', span('2026-05-01', '2026-05-15'));
    expect(zeroRowCandidates([overdue], '2026-05-25', TODAY)).toEqual([overdue]);
    // But a week before the span began never shows it.
    expect(zeroRowCandidates([overdue], '2026-04-20', TODAY)).toEqual([]);
  });

  it('keeps an undated open task in every week so unscheduled work stays loggable', () => {
    const undated = task('a', { status: 'NOT_STARTED' });
    expect(zeroRowCandidates([undated], MONDAY, TODAY)).toEqual([undated]);
    expect(zeroRowCandidates([undated], '2026-09-07', TODAY)).toEqual([undated]);
  });

  it('treats a payload predating the span fields as undated', () => {
    const legacy = { ...task('a') } as Partial<MyWorkTask>;
    delete legacy.scheduled_start;
    delete legacy.scheduled_finish;
    expect(zeroRowCandidates([legacy as MyWorkTask], MONDAY, TODAY)).toHaveLength(1);
  });

  it('treats a span with one missing end as open on that side', () => {
    const startOnly = task('a', span('2026-06-01', null));
    const finishOnly = task('b', span(null, '2026-07-01'));
    const startsLater = task('c', span('2026-07-01', null));
    expect(zeroRowCandidates([startOnly, finishOnly, startsLater], MONDAY, TODAY)).toEqual([
      startOnly,
      finishOnly,
    ]);
  });

  it('still shows a filtered-out task that has an entry this week', () => {
    const done = task('a', { status: 'COMPLETE' });
    const entry: WeeklyEntry = {
      id: 'e1',
      task: 'a',
      task_short_id: 'A',
      task_name: 'Task a',
      project: 'p1',
      project_code: 'WEB',
      project_name: 'Web',
      minutes: 30,
      entry_date: MONDAY,
      note: '',
      source: 'manual',
      server_version: 1,
      created_at: `${MONDAY}T09:00:00Z`,
    };
    const rows = buildWeekRows(
      [entry],
      zeroRowCandidates([done], MONDAY, TODAY).map(myWorkTaskMeta),
    );
    expect(rows.map((r) => r.taskId)).toEqual(['a']);
  });
});

describe('assignedTasks', () => {
  it('drops phases and de-duplicates across page boundaries', () => {
    const out = assignedTasks([task('a'), task('a'), task('p', { is_phase: true })]);
    expect(out.map((t) => t.id)).toEqual(['a']);
  });
});
