import { describe, expect, it, beforeEach } from 'vitest';
import { useGanttStore } from './ganttStore';

describe('useGanttStore', () => {
  beforeEach(() => {
    useGanttStore.setState({ zoomLevel: 'week', selectedTaskId: null });
  });

  it('starts with week zoom and no selection', () => {
    expect(useGanttStore.getState().zoomLevel).toBe('week');
    expect(useGanttStore.getState().selectedTaskId).toBeNull();
  });

  it('setZoomLevel updates zoom', () => {
    useGanttStore.getState().setZoomLevel('month');
    expect(useGanttStore.getState().zoomLevel).toBe('month');
  });

  it('setSelectedTaskId selects a task', () => {
    useGanttStore.getState().setSelectedTaskId('t1');
    expect(useGanttStore.getState().selectedTaskId).toBe('t1');
  });

  it('setSelectedTaskId(null) clears selection', () => {
    useGanttStore.setState({ selectedTaskId: 't1' });
    useGanttStore.getState().setSelectedTaskId(null);
    expect(useGanttStore.getState().selectedTaskId).toBeNull();
  });
});
