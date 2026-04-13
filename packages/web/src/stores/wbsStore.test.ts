import { describe, it, expect, beforeEach } from 'vitest';
import { useWbsStore } from './wbsStore';

describe('wbsStore', () => {
  beforeEach(() => {
    useWbsStore.setState({
      expandedIds: new Set(),
      selectedTaskId: null,
    });
  });

  it('toggle adds and removes IDs from expandedIds', () => {
    useWbsStore.getState().toggle('t1');
    expect(useWbsStore.getState().expandedIds.has('t1')).toBe(true);

    useWbsStore.getState().toggle('t1');
    expect(useWbsStore.getState().expandedIds.has('t1')).toBe(false);
  });

  it('expandAll replaces the set', () => {
    useWbsStore.getState().expandAll(['t1', 't2', 't3']);
    expect(useWbsStore.getState().expandedIds.size).toBe(3);
  });

  it('collapseAll empties the set', () => {
    useWbsStore.getState().expandAll(['t1', 't2']);
    useWbsStore.getState().collapseAll();
    expect(useWbsStore.getState().expandedIds.size).toBe(0);
  });

  it('setSelectedTaskId sets and clears selection', () => {
    useWbsStore.getState().setSelectedTaskId('t1');
    expect(useWbsStore.getState().selectedTaskId).toBe('t1');

    useWbsStore.getState().setSelectedTaskId(null);
    expect(useWbsStore.getState().selectedTaskId).toBeNull();
  });
});
