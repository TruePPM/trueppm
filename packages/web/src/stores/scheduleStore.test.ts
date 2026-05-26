import { describe, expect, it, beforeEach } from 'vitest';
import { useScheduleStore } from './scheduleStore';

describe('useScheduleStore', () => {
  beforeEach(() => {
    localStorage.removeItem('schedule.quarterMode');
    useScheduleStore.setState({ zoomLevel: 'week', selectedTaskId: null, quarterMode: 'fiscal' });
  });

  it('starts with week zoom and no selection', () => {
    expect(useScheduleStore.getState().zoomLevel).toBe('week');
    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
  });

  it('setZoomLevel updates zoom', () => {
    useScheduleStore.getState().setZoomLevel('month');
    expect(useScheduleStore.getState().zoomLevel).toBe('month');
  });

  it('setSelectedTaskId selects a task', () => {
    useScheduleStore.getState().setSelectedTaskId('t1');
    expect(useScheduleStore.getState().selectedTaskId).toBe('t1');
  });

  it('setSelectedTaskId(null) clears selection', () => {
    useScheduleStore.setState({ selectedTaskId: 't1' });
    useScheduleStore.getState().setSelectedTaskId(null);
    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
  });

  it('scrollToTask sets scrollToTaskId', () => {
    useScheduleStore.getState().scrollToTask('t2');
    expect(useScheduleStore.getState().scrollToTaskId).toBe('t2');
  });

  it('scrollToTask(null) clears scrollToTaskId', () => {
    useScheduleStore.setState({ scrollToTaskId: 't2' });
    useScheduleStore.getState().scrollToTask(null);
    expect(useScheduleStore.getState().scrollToTaskId).toBeNull();
  });

  it('defaults quarterMode to fiscal', () => {
    expect(useScheduleStore.getState().quarterMode).toBe('fiscal');
  });

  it('setQuarterMode updates state and persists to localStorage (#755)', () => {
    useScheduleStore.getState().setQuarterMode('calendar');
    expect(useScheduleStore.getState().quarterMode).toBe('calendar');
    expect(localStorage.getItem('schedule.quarterMode')).toBe('calendar');
    useScheduleStore.getState().setQuarterMode('fiscal');
    expect(localStorage.getItem('schedule.quarterMode')).toBe('fiscal');
  });
});
