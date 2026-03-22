import { describe, expect, it } from 'vitest';
import { toSvarTask, toSvarTasks } from './toSvarTasks';
import type { Task } from '@/types';

const base: Task = {
  id: 't1', wbs: '1.1', name: 'Design', start: '2026-10-05', finish: '2026-10-15',
  duration: 10, progress: 50, parentId: null,
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
};

describe('toSvarTask', () => {
  it('maps basic fields correctly', () => {
    const result = toSvarTask(base);
    expect(result.id).toBe('t1');
    expect(result.text).toBe('Design');
    expect(result.duration).toBe(10);
    expect(result.progress).toBe(0.5); // 50/100
    expect(result.type).toBe('task');
  });

  it('maps parentId null to parent 0', () => {
    expect(toSvarTask(base).parent).toBe(0);
  });

  it('maps parentId to parent string', () => {
    expect(toSvarTask({ ...base, parentId: 'p1' }).parent).toBe('p1');
  });

  it('sets type=milestone for milestones', () => {
    expect(toSvarTask({ ...base, isMilestone: true }).type).toBe('milestone');
  });

  it('sets type=summary for summary tasks (takes priority over milestone=false)', () => {
    expect(toSvarTask({ ...base, isSummary: true }).type).toBe('summary');
  });

  it('sets $critical custom field', () => {
    expect(toSvarTask({ ...base, isCritical: true }).$critical).toBe(true);
    expect(toSvarTask(base).$critical).toBe(false);
  });

  it('sets $complete custom field', () => {
    expect(toSvarTask({ ...base, isComplete: true }).$complete).toBe(true);
  });

  it('maps baseline dates when present', () => {
    const result = toSvarTask({ ...base, baselineStart: '2026-10-01', baselineFinish: '2026-10-12' });
    expect(result.base_start).toEqual(new Date('2026-10-01'));
    expect(result.base_end).toEqual(new Date('2026-10-12'));
  });

  it('omits base_start/base_end when no baseline', () => {
    const result = toSvarTask(base);
    expect(result.base_start).toBeUndefined();
    expect(result.base_end).toBeUndefined();
  });

  it('converts start/end to Date objects', () => {
    const result = toSvarTask(base);
    expect(result.start).toBeInstanceOf(Date);
    expect(result.end).toBeInstanceOf(Date);
  });
});

describe('toSvarTasks', () => {
  it('maps an array of tasks', () => {
    const tasks = [base, { ...base, id: 't2', wbs: '1.2', name: 'Build' }];
    const result = toSvarTasks(tasks);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('t1');
    expect(result[1].id).toBe('t2');
  });
});
