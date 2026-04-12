import { describe, expect, it, beforeEach } from 'vitest';
import { useTaskRunStore, type TaskRunEntry } from './taskRunStore';

function makeEntry(overrides: Partial<TaskRunEntry> = {}): TaskRunEntry {
  return {
    taskRunId: 'run-1',
    taskName: 'CPM Calculation',
    projectId: 'proj-1',
    pct: 0,
    msg: 'Starting',
    status: 'running',
    ...overrides,
  };
}

describe('useTaskRunStore', () => {
  beforeEach(() => {
    useTaskRunStore.setState({ runs: {}, activeCount: 0 });
  });

  it('addRun inserts an entry and increments activeCount', () => {
    useTaskRunStore.getState().addRun(makeEntry());
    const { runs, activeCount } = useTaskRunStore.getState();
    expect(runs['run-1']).toBeDefined();
    expect(activeCount).toBe(1);
  });

  it('updateProgress updates pct and msg for an existing run', () => {
    useTaskRunStore.getState().addRun(makeEntry());
    useTaskRunStore.getState().updateProgress('run-1', 50, 'Halfway');
    const entry = useTaskRunStore.getState().runs['run-1'];
    expect(entry.pct).toBe(50);
    expect(entry.msg).toBe('Halfway');
  });

  it('updateProgress is a no-op for unknown taskRunId', () => {
    useTaskRunStore.getState().addRun(makeEntry());
    useTaskRunStore.getState().updateProgress('unknown', 50, 'Nope');
    expect(useTaskRunStore.getState().runs['unknown']).toBeUndefined();
  });

  it('completeRun sets status to completed and decrements activeCount', () => {
    useTaskRunStore.getState().addRun(makeEntry());
    useTaskRunStore.getState().completeRun('run-1', { tasks: 42 });
    const { runs, activeCount } = useTaskRunStore.getState();
    expect(runs['run-1'].status).toBe('completed');
    expect(runs['run-1'].pct).toBe(100);
    expect(activeCount).toBe(0);
  });

  it('completeRun is a no-op for unknown taskRunId', () => {
    useTaskRunStore.getState().completeRun('unknown', null);
    expect(useTaskRunStore.getState().activeCount).toBe(0);
  });

  it('failRun sets status to failed and records error message', () => {
    useTaskRunStore.getState().addRun(makeEntry());
    useTaskRunStore.getState().failRun('run-1', 'Timeout');
    const entry = useTaskRunStore.getState().runs['run-1'];
    expect(entry.status).toBe('failed');
    expect(entry.msg).toBe('Timeout');
  });

  it('failRun is a no-op for unknown taskRunId', () => {
    useTaskRunStore.getState().failRun('unknown', 'err');
    expect(useTaskRunStore.getState().activeCount).toBe(0);
  });

  it('cancelRun sets status to cancelled and decrements activeCount', () => {
    useTaskRunStore.getState().addRun(makeEntry());
    useTaskRunStore.getState().cancelRun('run-1');
    const entry = useTaskRunStore.getState().runs['run-1'];
    expect(entry.status).toBe('cancelled');
    expect(useTaskRunStore.getState().activeCount).toBe(0);
  });

  it('cancelRun is a no-op for unknown taskRunId', () => {
    useTaskRunStore.getState().cancelRun('unknown');
    expect(useTaskRunStore.getState().activeCount).toBe(0);
  });

  it('activeCount does not go below zero', () => {
    useTaskRunStore.setState({ runs: { 'run-1': makeEntry() }, activeCount: 0 });
    useTaskRunStore.getState().completeRun('run-1', null);
    expect(useTaskRunStore.getState().activeCount).toBe(0);
  });

  it('handles multiple concurrent runs', () => {
    useTaskRunStore.getState().addRun(makeEntry({ taskRunId: 'run-1' }));
    useTaskRunStore.getState().addRun(makeEntry({ taskRunId: 'run-2', taskName: 'Monte Carlo' }));
    expect(useTaskRunStore.getState().activeCount).toBe(2);

    useTaskRunStore.getState().completeRun('run-1', null);
    expect(useTaskRunStore.getState().activeCount).toBe(1);
    expect(useTaskRunStore.getState().runs['run-2'].status).toBe('running');
  });
});
