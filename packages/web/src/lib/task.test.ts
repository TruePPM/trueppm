import { describe, it, expect } from 'vitest';
import { isTaskScheduled, taskScheduleState } from './task';

describe('isTaskScheduled', () => {
  it('returns false when plannedStart is null and there is no sprint', () => {
    expect(isTaskScheduled({ plannedStart: null, sprintId: null })).toBe(false);
  });

  it('returns false when plannedStart and sprintId are both undefined', () => {
    // Older API responses may omit the fields entirely.
    expect(isTaskScheduled({})).toBe(false);
  });

  it('returns true when plannedStart is set, regardless of sprint', () => {
    expect(isTaskScheduled({ plannedStart: '2026-04-06', sprintId: null })).toBe(true);
  });

  it('returns true when assigned to a sprint, even without plannedStart', () => {
    // Sprint membership is itself a scheduling commitment — the sprint is the
    // container.
    expect(isTaskScheduled({ plannedStart: null, sprintId: 'sprint-uuid' })).toBe(true);
  });
});

describe('taskScheduleState', () => {
  it("is 'unscheduled' when plannedStart is null and there is no sprint", () => {
    expect(taskScheduleState({ plannedStart: null, sprintId: null })).toBe('unscheduled');
    expect(isTaskScheduled({ plannedStart: null, sprintId: null })).toBe(false);
  });

  it("is 'unscheduled' when plannedStart and sprintId are both undefined", () => {
    expect(taskScheduleState({})).toBe('unscheduled');
    expect(isTaskScheduled({})).toBe(false);
  });

  it("is 'scheduled' when plannedStart is set, regardless of sprint", () => {
    expect(taskScheduleState({ plannedStart: '2026-04-06', sprintId: null })).toBe('scheduled');
    expect(isTaskScheduled({ plannedStart: '2026-04-06', sprintId: null })).toBe(true);
  });

  it("is 'scheduled' when assigned to a sprint, even without plannedStart", () => {
    expect(taskScheduleState({ plannedStart: null, sprintId: 'sprint-uuid' })).toBe('scheduled');
    expect(isTaskScheduled({ plannedStart: null, sprintId: 'sprint-uuid' })).toBe(true);
  });
});
