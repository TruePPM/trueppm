import { describe, expect, it, beforeEach } from 'vitest';
import { ZOOM_CONFIGS, clampPxPerDay, deriveTier } from '@/features/schedule/engine';
import { useScheduleStore } from './scheduleStore';

describe('useScheduleStore', () => {
  beforeEach(() => {
    localStorage.removeItem('schedule.quarterMode');
    localStorage.removeItem('schedule.viewMode');
    // Reset the FULL consistent default state, not just zoomLevel. pxPerDay is
    // the source of truth and zoomLevel is derived from it (deriveTier), so
    // restoring zoomLevel: 'week' without pxPerDay: ZOOM_CONFIGS.week.pxPerDay
    // would leave the store in a state its own invariant forbids — and any later
    // test asserting a pxPerDay-derived value would pass or fail by test order.
    // scrollToTaskId is reset too so a leaked scroll target can't bleed across
    // tests (issue 1515).
    useScheduleStore.setState({
      pxPerDay: ZOOM_CONFIGS.week.pxPerDay,
      zoomLevel: 'week',
      selectedTaskId: null,
      scrollToTaskId: null,
      quarterMode: 'fiscal',
      viewMode: 'grid',
    });
  });

  it('starts with week zoom and no selection', () => {
    expect(useScheduleStore.getState().zoomLevel).toBe('week');
    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
  });

  // `setPxPerDay` is the store's only zoom mutation since `setZoomLevel` was
  // deleted unreferenced (#3369). It is the half that survived, so the
  // pxPerDay-is-truth / zoomLevel-is-derived invariant is asserted here rather
  // than only through ZoomControl.
  it('setPxPerDay re-derives zoomLevel from the new scale', () => {
    useScheduleStore.getState().setPxPerDay(ZOOM_CONFIGS.month.pxPerDay);
    const { pxPerDay, zoomLevel } = useScheduleStore.getState();
    expect(pxPerDay).toBe(ZOOM_CONFIGS.month.pxPerDay);
    expect(zoomLevel).toBe('month');
  });

  it('setPxPerDay clamps an out-of-range scale and still derives a valid tier', () => {
    useScheduleStore.getState().setPxPerDay(-1000);
    const { pxPerDay, zoomLevel } = useScheduleStore.getState();
    expect(pxPerDay).toBe(clampPxPerDay(-1000));
    expect(zoomLevel).toBe(deriveTier(pxPerDay));
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

  it('defaults viewMode to grid (#1221)', () => {
    expect(useScheduleStore.getState().viewMode).toBe('grid');
  });

  it('setViewMode updates state and persists to localStorage (#1221)', () => {
    useScheduleStore.getState().setViewMode('timeline');
    expect(useScheduleStore.getState().viewMode).toBe('timeline');
    expect(localStorage.getItem('schedule.viewMode')).toBe('timeline');
    useScheduleStore.getState().setViewMode('grid');
    expect(useScheduleStore.getState().viewMode).toBe('grid');
    expect(localStorage.getItem('schedule.viewMode')).toBe('grid');
  });
});
