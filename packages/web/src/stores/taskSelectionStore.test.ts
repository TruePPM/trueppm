import { describe, expect, it, beforeEach } from 'vitest';
import { useTaskSelectionStore } from './taskSelectionStore';

describe('useTaskSelectionStore', () => {
  beforeEach(() => {
    useTaskSelectionStore.setState({ selectedIds: new Set<string>() });
  });

  it('starts with an empty selection', () => {
    expect(useTaskSelectionStore.getState().selectedIds.size).toBe(0);
  });

  it('toggle adds an unselected id', () => {
    useTaskSelectionStore.getState().toggle('t1');
    expect(useTaskSelectionStore.getState().selectedIds.has('t1')).toBe(true);
  });

  it('toggle removes an already-selected id', () => {
    useTaskSelectionStore.getState().toggle('t1');
    useTaskSelectionStore.getState().toggle('t1');
    expect(useTaskSelectionStore.getState().selectedIds.has('t1')).toBe(false);
    expect(useTaskSelectionStore.getState().selectedIds.size).toBe(0);
  });

  it('toggle produces a new Set reference each call so subscribers re-render', () => {
    const before = useTaskSelectionStore.getState().selectedIds;
    useTaskSelectionStore.getState().toggle('t1');
    const after = useTaskSelectionStore.getState().selectedIds;
    // A mutated-in-place Set would keep the same identity and skip renders.
    expect(after).not.toBe(before);
  });

  it('selectAll replaces the selection with the given ids', () => {
    useTaskSelectionStore.getState().toggle('stale');
    useTaskSelectionStore.getState().selectAll(['a', 'b', 'c']);
    const { selectedIds } = useTaskSelectionStore.getState();
    expect([...selectedIds].sort()).toEqual(['a', 'b', 'c']);
    expect(selectedIds.has('stale')).toBe(false);
  });

  it('clearSelection empties the selection', () => {
    useTaskSelectionStore.getState().selectAll(['a', 'b']);
    useTaskSelectionStore.getState().clearSelection();
    expect(useTaskSelectionStore.getState().selectedIds.size).toBe(0);
  });
});
