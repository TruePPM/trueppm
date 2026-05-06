import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '@/types';
import { OutlineMode } from './OutlineMode';
import { emptyFilters } from './filters';
import { useWbsStore } from '@/stores/wbsStore';

const mockTasks: Task[] = [
  {
    id: 'p1', wbs: '1', name: 'Phase 1', start: '2026-05-01', finish: '2026-05-30',
    duration: 30, progress: 0, parentId: null,
    isCritical: false, isComplete: false, isSummary: true, isMilestone: false,
    status: 'IN_PROGRESS', assignees: [],
  },
  {
    id: 't1', wbs: '1.1', name: 'Discovery', start: '2026-05-01', finish: '2026-05-10',
    duration: 10, progress: 30, parentId: 'p1',
    isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
    status: 'IN_PROGRESS', assignees: [{ resourceId: 'r1', name: 'Alice', units: 100 }],
  },
  {
    id: 't2', wbs: '1.2', name: 'Build', start: '2026-05-11', finish: '2026-05-20',
    duration: 10, progress: 0, parentId: 'p1',
    isCritical: true, isComplete: false, isSummary: false, isMilestone: false,
    status: 'NOT_STARTED', assignees: [],
  },
];

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, links: [], isLoading: false, error: null }),
}));

const indentMutate = vi.fn((_id: string, opts?: { onSuccess?: (data: unknown) => void; onError?: () => void }) => {
  opts?.onSuccess?.({ warning: null });
});
const outdentMutate = vi.fn((_id: string, opts?: { onSuccess?: (data: unknown) => void; onError?: () => void }) => {
  opts?.onSuccess?.({ warning: 'has_assignments' });
});
const reorderMutate = vi.fn(
  (
    _payload: { parent_path: string; ordered_ids: string[] },
    opts?: { onSuccess?: () => void; onError?: () => void },
  ) => {
    opts?.onSuccess?.();
  },
);

vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate: vi.fn(), isPending: false }),
  useReorderTasks: () => ({ mutate: reorderMutate, isPending: false }),
  useIndentTask: () => ({ mutate: indentMutate, isPending: false }),
  useOutdentTask: () => ({ mutate: outdentMutate, isPending: false }),
  useReparentTask: () => ({ mutate: vi.fn(), isPending: false }),
}));

beforeEach(() => {
  // Reset Zustand-backed wbs store so each test starts with a clean slate.
  useWbsStore.setState({ expandedIds: new Set(), selectedTaskId: null });
  indentMutate.mockClear();
  outdentMutate.mockClear();
  reorderMutate.mockClear();
});

function renderOutline() {
  return render(
    <OutlineMode
      filters={emptyFilters()}
      onClearFilters={vi.fn()}
      expandAllCounter={0}
      collapseAllCounter={0}
    />,
  );
}

describe('OutlineMode — keyboard handlers', () => {
  it('Tab triggers indent on the selected task', () => {
    renderOutline();
    act(() => useWbsStore.setState({ selectedTaskId: 't2' }));
    const grid = screen.getByRole('treegrid', { name: /outline task tree/i });
    fireEvent.keyDown(grid, { key: 'Tab' });
    expect(indentMutate).toHaveBeenCalledWith('t2', expect.any(Object));
  });

  it('Shift+Tab triggers outdent on the selected task', () => {
    renderOutline();
    act(() => useWbsStore.setState({ selectedTaskId: 't1' }));
    const grid = screen.getByRole('treegrid', { name: /outline task tree/i });
    fireEvent.keyDown(grid, { key: 'Tab', shiftKey: true });
    expect(outdentMutate).toHaveBeenCalledWith('t1', expect.any(Object));
  });

  it('Tab is a no-op when nothing is selected', () => {
    renderOutline();
    const grid = screen.getByRole('treegrid', { name: /outline task tree/i });
    fireEvent.keyDown(grid, { key: 'Tab' });
    expect(indentMutate).not.toHaveBeenCalled();
  });

  it('Alt+ArrowDown reorders within siblings', () => {
    renderOutline();
    act(() => useWbsStore.setState({ expandedIds: new Set(['p1']), selectedTaskId: 't1' }));
    const grid = screen.getByRole('treegrid', { name: /outline task tree/i });
    fireEvent.keyDown(grid, { key: 'ArrowDown', altKey: true });
    expect(reorderMutate).toHaveBeenCalled();
  });

  it('Alt+ArrowUp on the first sibling is a no-op', () => {
    renderOutline();
    act(() => useWbsStore.setState({ expandedIds: new Set(['p1']), selectedTaskId: 't1' }));
    const grid = screen.getByRole('treegrid', { name: /outline task tree/i });
    fireEvent.keyDown(grid, { key: 'ArrowUp', altKey: true });
    expect(reorderMutate).not.toHaveBeenCalled();
  });

  it('ArrowDown moves the selection to the next visible row', () => {
    renderOutline();
    act(() => useWbsStore.setState({ expandedIds: new Set(['p1']), selectedTaskId: 'p1' }));
    const grid = screen.getByRole('treegrid', { name: /outline task tree/i });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(useWbsStore.getState().selectedTaskId).toBe('t1');
  });

  it('ArrowUp is clamped at the first row', () => {
    renderOutline();
    act(() => useWbsStore.setState({ selectedTaskId: 'p1' }));
    const grid = screen.getByRole('treegrid', { name: /outline task tree/i });
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    expect(useWbsStore.getState().selectedTaskId).toBe('p1');
  });
});

describe('OutlineMode — rendering', () => {
  it('renders the tree with the WBS columns including Predecessors', () => {
    renderOutline();
    expect(screen.getByText('Predecessors', { exact: true })).toBeInTheDocument();
    expect(screen.getByRole('treegrid', { name: /outline task tree/i })).toBeInTheDocument();
  });

  it('renders the filtered-empty state when filters yield zero matches', () => {
    render(
      <OutlineMode
        filters={{ search: 'no-such-task', ownerFilter: '', statusFilter: '' }}
        onClearFilters={vi.fn()}
        expandAllCounter={0}
        collapseAllCounter={0}
      />,
    );
    expect(screen.getByText(/no tasks match these filters/i)).toBeInTheDocument();
  });
});
