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
    ...extra,
  } as MyWorkTask;
}

const MONDAY = '2026-06-15';

describe('zeroRowCandidates (#4766)', () => {
  it('excludes a completed task', () => {
    expect(zeroRowCandidates([task('a', { status: 'COMPLETE', due: MONDAY })])).toEqual([]);
  });

  it('keeps an open task dated outside the selected week — overdue work is still current', () => {
    const before = task('a', { due: '2026-05-01' });
    const after = task('b', { due: '2026-09-01' });
    expect(zeroRowCandidates([before, after])).toEqual([before, after]);
  });

  it('keeps an undated open task so unscheduled work stays loggable', () => {
    const undated = task('a', { due: null, status: 'NOT_STARTED' });
    expect(zeroRowCandidates([undated])).toEqual([undated]);
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
    const rows = buildWeekRows([entry], zeroRowCandidates([done]).map(myWorkTaskMeta));
    expect(rows.map((r) => r.taskId)).toEqual(['a']);
  });
});

describe('assignedTasks', () => {
  it('drops phases and de-duplicates across page boundaries', () => {
    const out = assignedTasks([task('a'), task('a'), task('p', { is_phase: true })]);
    expect(out.map((t) => t.id)).toEqual(['a']);
  });
});
