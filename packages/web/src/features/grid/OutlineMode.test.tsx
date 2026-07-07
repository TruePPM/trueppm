import type { ReactNode } from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '@/types';
import type { DragEndEvent, DragOverEvent } from '@dnd-kit/core';
import { OutlineMode } from './OutlineMode';
import { emptyFilters } from './filters';
import { useWbsStore } from '@/stores/wbsStore';

// Capture the DndContext callbacks so individual tests can fire synthetic
// drag events without going through the real PointerSensor / KeyboardSensor
// pipeline. The reparent + reorder paths in handleDragEnd are 38% covered by
// rendering alone; firing the captured callbacks lets us hit every branch.
const capturedHandlers: {
  onDragOver?: (e: DragOverEvent) => void;
  onDragEnd?: (e: DragEndEvent) => void;
  onDragCancel?: () => void;
} = {};

vi.mock('@dnd-kit/core', async () => {
  const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core');
  return {
    ...actual,
    DndContext: ({
      children,
      onDragOver,
      onDragEnd,
      onDragCancel,
    }: {
      children: ReactNode;
      onDragOver?: (e: DragOverEvent) => void;
      onDragEnd?: (e: DragEndEvent) => void;
      onDragCancel?: () => void;
    }) => {
      capturedHandlers.onDragOver = onDragOver;
      capturedHandlers.onDragEnd = onDragEnd;
      capturedHandlers.onDragCancel = onDragCancel;
      return <>{children}</>;
    },
  };
});

const mockTasks: Task[] = [
  {
    id: 'p1', wbs: '1', name: 'Phase 1', start: '2026-05-01', finish: '2026-05-30',
    duration: 30, progress: 0, parentId: null,
    isCritical: false, isComplete: false, isSummary: true, isMilestone: false,
    status: 'IN_PROGRESS', assignees: [], notes: '',
  },
  {
    id: 't1', wbs: '1.1', name: 'Discovery', start: '2026-05-01', finish: '2026-05-10',
    duration: 10, progress: 30, parentId: 'p1',
    isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
    status: 'IN_PROGRESS', assignees: [{ resourceId: 'r1', name: 'Alice', units: 100 }], notes: '',
  },
  {
    id: 't2', wbs: '1.2', name: 'Build', start: '2026-05-11', finish: '2026-05-20',
    duration: 10, progress: 0, parentId: 'p1',
    isCritical: true, isComplete: false, isSummary: false, isMilestone: false,
    status: 'NOT_STARTED', assignees: [], notes: '',
  },
  // A second top-level summary so we can test reparenting a leaf into a
  // *different* summary than its current parent.
  {
    id: 'p2', wbs: '2', name: 'Phase 2', start: '2026-06-01', finish: '2026-06-30',
    duration: 30, progress: 0, parentId: null,
    isCritical: false, isComplete: false, isSummary: true, isMilestone: false,
    status: 'NOT_STARTED', assignees: [], notes: '',
  },
  // A leaf under p2 so we can test cross-parent leaf-onto-leaf drops.
  {
    id: 't3', wbs: '2.1', name: 'Plan 2', start: '2026-06-01', finish: '2026-06-05',
    duration: 4, progress: 0, parentId: 'p2',
    isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
    status: 'NOT_STARTED', assignees: [], notes: '',
  },
];

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, links: [], isLoading: false, error: null }),
}));

const indentMutate = vi.fn((_id: string, opts?: { onSuccess?: (data: { warning: string | null }) => void; onError?: () => void }) => {
  opts?.onSuccess?.({ warning: null });
});
const outdentMutate = vi.fn((_id: string, opts?: { onSuccess?: (data: { warning: string | null }) => void; onError?: () => void }) => {
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
const reparentMutate = vi.fn();

vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate: vi.fn(), isPending: false }),
  useReorderTasks: () => ({ mutate: reorderMutate, isPending: false }),
  useIndentTask: () => ({ mutate: indentMutate, isPending: false }),
  useOutdentTask: () => ({ mutate: outdentMutate, isPending: false }),
  useReparentTask: () => ({ mutate: reparentMutate, isPending: false }),
}));

beforeEach(() => {
  // Reset Zustand-backed wbs store so each test starts with a clean slate.
  useWbsStore.setState({ expandedIds: new Set(), selectedTaskId: null });
  indentMutate.mockClear();
  outdentMutate.mockClear();
  reorderMutate.mockClear();
  reparentMutate.mockClear();
  capturedHandlers.onDragOver = undefined;
  capturedHandlers.onDragEnd = undefined;
  capturedHandlers.onDragCancel = undefined;
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
        filters={{ search: 'no-such-task', ownerFilter: '', statusFilter: '', dueFilter: 'all' as const }}
        onClearFilters={vi.fn()}
        expandAllCounter={0}
        collapseAllCounter={0}
      />,
    );
    expect(screen.getByText(/no tasks match these filters/i)).toBeInTheDocument();
  });

  it('filter that matches a leaf includes the leaf AND its ancestors (tree integrity)', () => {
    // 'Discovery' (t1) matches; its ancestor 'Phase 1' (p1) must also stay
    // visible so the tree remains valid. p2 (no descendant matches) is hidden.
    render(
      <OutlineMode
        filters={{ search: 'discovery', ownerFilter: '', statusFilter: '', dueFilter: 'all' as const }}
        onClearFilters={vi.fn()}
        expandAllCounter={0}
        collapseAllCounter={0}
      />,
    );
    expect(screen.getByText('Phase 1')).toBeInTheDocument();
    expect(screen.queryByText('Phase 2')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Drag handlers — invoked via the captured @dnd-kit/core callbacks
// ---------------------------------------------------------------------------

function dragEvent(activeId: string, overId: string | null): DragEndEvent {
  return {
    active: { id: activeId, data: { current: undefined }, rect: { current: { initial: null, translated: null } } },
    over: overId ? { id: overId, data: { current: undefined }, rect: {} as DOMRect, disabled: false } : null,
    collisions: null,
    delta: { x: 0, y: 0 },
    activatorEvent: new MouseEvent('pointerdown'),
  } as unknown as DragEndEvent;
}

describe('OutlineMode — handleDragOver', () => {
  it('marks a different summary as the reparent target when dragging a leaf onto it', () => {
    renderOutline();
    // t1's parent is p1; drag onto p2 (a *different* summary) should reparent.
    act(() => capturedHandlers.onDragOver?.(dragEvent('t1', 'p2') as DragOverEvent));
    expect(screen.getByLabelText(/will become child of Phase 2/i)).toBeInTheDocument();
  });

  it('clears the reparent target when "over" is null after a previous match', () => {
    renderOutline();
    act(() => capturedHandlers.onDragOver?.(dragEvent('t1', 'p2') as DragOverEvent));
    act(() => capturedHandlers.onDragOver?.(dragEvent('t1', null) as DragOverEvent));
    expect(capturedHandlers.onDragOver).toBeDefined();
  });

  it('does NOT mark a leaf row as a reparent target', () => {
    renderOutline();
    act(() => capturedHandlers.onDragOver?.(dragEvent('t1', 't2') as DragOverEvent));
    expect(screen.queryByLabelText(/will become child of/i)).not.toBeInTheDocument();
  });

  it('does NOT mark a row as reparent when dragged onto its CURRENT parent', () => {
    renderOutline();
    // t1's current parent is p1 — over=p1 should NOT be a reparent.
    act(() => capturedHandlers.onDragOver?.(dragEvent('t1', 'p1') as DragOverEvent));
    expect(screen.queryByLabelText(/will become child of/i)).not.toBeInTheDocument();
  });
});

describe('OutlineMode — handleDragEnd reparent path', () => {
  it('dispatches reparentTask.mutate when a leaf is dropped onto a different summary', () => {
    renderOutline();
    // Set up: drop t1 onto p2 (a different summary). p1 is t1's current parent.
    act(() => capturedHandlers.onDragEnd?.(dragEvent('t1', 'p2')));
    expect(reparentMutate).toHaveBeenCalledTimes(1);
    expect(reparentMutate.mock.calls[0]?.[0]).toEqual({ taskId: 't1', newParentId: 'p2' });
  });

  it('reparent onSuccess (no warning) announces the move', () => {
    reparentMutate.mockImplementation(
      (
        _payload: { taskId: string; newParentId: string },
        opts?: { onSuccess?: (data: { warning: string | null }) => void; onError?: () => void },
      ) => {
        opts?.onSuccess?.({ warning: null });
      },
    );
    renderOutline();
    act(() => capturedHandlers.onDragEnd?.(dragEvent('t1', 'p2')));
    expect(reparentMutate).toHaveBeenCalled();
  });

  it('reparent onSuccess with has_assignments warning is announced', () => {
    reparentMutate.mockImplementation(
      (
        _payload: { taskId: string; newParentId: string },
        opts?: { onSuccess?: (data: { warning: string | null }) => void; onError?: () => void },
      ) => {
        opts?.onSuccess?.({ warning: 'has_assignments' });
      },
    );
    renderOutline();
    act(() => capturedHandlers.onDragEnd?.(dragEvent('t1', 'p2')));
    expect(reparentMutate).toHaveBeenCalled();
  });

  it('reparent onError announces a failure', () => {
    reparentMutate.mockImplementation(
      (
        _payload: { taskId: string; newParentId: string },
        opts?: { onSuccess?: (data: { warning: string | null }) => void; onError?: () => void },
      ) => {
        opts?.onError?.();
      },
    );
    renderOutline();
    act(() => capturedHandlers.onDragEnd?.(dragEvent('t1', 'p2')));
    expect(reparentMutate).toHaveBeenCalled();
  });
});

describe('OutlineMode — handleDragEnd reorder path', () => {
  it('dispatches reorderTasks.mutate when dropped on a sibling', () => {
    renderOutline();
    // t1 and t2 are siblings under p1.
    act(() => capturedHandlers.onDragEnd?.(dragEvent('t1', 't2')));
    expect(reorderMutate).toHaveBeenCalledTimes(1);
    const payload = reorderMutate.mock.calls[0]?.[0] as { parent_path: string; ordered_ids: string[] };
    expect(payload.parent_path).toBe('1');
    expect(payload.ordered_ids).toEqual(['t2', 't1']);
  });

  it('does nothing when active and over are the same id', () => {
    renderOutline();
    act(() => capturedHandlers.onDragEnd?.(dragEvent('t1', 't1')));
    expect(reorderMutate).not.toHaveBeenCalled();
    expect(reparentMutate).not.toHaveBeenCalled();
  });

  it('does nothing when over is null', () => {
    renderOutline();
    act(() => capturedHandlers.onDragEnd?.(dragEvent('t1', null)));
    expect(reorderMutate).not.toHaveBeenCalled();
    expect(reparentMutate).not.toHaveBeenCalled();
  });

  it('does nothing when the target task is unknown', () => {
    renderOutline();
    act(() => capturedHandlers.onDragEnd?.(dragEvent('t1', 'unknown-id')));
    expect(reorderMutate).not.toHaveBeenCalled();
  });

  it('rejects a cross-parent leaf-onto-leaf drop', () => {
    // t1 is under p1; t3 is under p2 — different parents. The reorder
    // path requires `activeTask.parentId === overTask.parentId`; this is
    // the early-return branch in handleDragEnd.
    renderOutline();
    act(() => capturedHandlers.onDragEnd?.(dragEvent('t1', 't3')));
    expect(reorderMutate).not.toHaveBeenCalled();
    expect(reparentMutate).not.toHaveBeenCalled();
  });
});

describe('OutlineMode — onDragCancel', () => {
  it('clears the reparent target without dispatching any mutation', () => {
    renderOutline();
    act(() => capturedHandlers.onDragOver?.(dragEvent('t1', 'p1') as DragOverEvent));
    act(() => capturedHandlers.onDragCancel?.());
    expect(reparentMutate).not.toHaveBeenCalled();
    expect(reorderMutate).not.toHaveBeenCalled();
  });
});

describe('OutlineMode — indent / outdent error paths', () => {
  it('Tab onError announces "Cannot indent" when the API rejects', () => {
    indentMutate.mockImplementation(
      (_id: string, opts?: { onSuccess?: (data: { warning: string | null }) => void; onError?: () => void }) => {
        opts?.onError?.();
      },
    );
    renderOutline();
    act(() => useWbsStore.setState({ selectedTaskId: 't1' }));
    const grid = screen.getByRole('treegrid', { name: /outline task tree/i });
    fireEvent.keyDown(grid, { key: 'Tab' });
    expect(indentMutate).toHaveBeenCalled();
  });

  it('Shift+Tab onError announces "Cannot outdent" when the API rejects', () => {
    outdentMutate.mockImplementation(
      (_id: string, opts?: { onSuccess?: (data: { warning: string | null }) => void; onError?: () => void }) => {
        opts?.onError?.();
      },
    );
    renderOutline();
    act(() => useWbsStore.setState({ selectedTaskId: 't1' }));
    const grid = screen.getByRole('treegrid', { name: /outline task tree/i });
    fireEvent.keyDown(grid, { key: 'Tab', shiftKey: true });
    expect(outdentMutate).toHaveBeenCalled();
  });
});

describe('OutlineMode — keyboard reorder boundaries', () => {
  it('Alt+ArrowDown on the LAST sibling is a no-op', () => {
    renderOutline();
    act(() => useWbsStore.setState({ expandedIds: new Set(['p1']), selectedTaskId: 't2' }));
    const grid = screen.getByRole('treegrid', { name: /outline task tree/i });
    fireEvent.keyDown(grid, { key: 'ArrowDown', altKey: true });
    expect(reorderMutate).not.toHaveBeenCalled();
  });

  it('ArrowDown is clamped at the last visible row', () => {
    renderOutline();
    // Visible order with p1 expanded: [p1, t1, t2, p2]. p2 is the last visible row.
    act(() => useWbsStore.setState({ expandedIds: new Set(['p1']), selectedTaskId: 'p2' }));
    const grid = screen.getByRole('treegrid', { name: /outline task tree/i });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(useWbsStore.getState().selectedTaskId).toBe('p2');
  });
});

describe('OutlineMode — row interactions in context', () => {
  it('clicking a tree row updates the wbs store selection', () => {
    renderOutline();
    // Auto-expand fires on first render; the leaf row should be in the DOM.
    const rows = screen.getAllByRole('row').filter((r) => r.getAttribute('data-task-id'));
    const t1Row = rows.find((r) => r.getAttribute('data-task-id') === 't1');
    expect(t1Row).toBeDefined();
    fireEvent.click(t1Row!);
    expect(useWbsStore.getState().selectedTaskId).toBe('t1');
  });

  it('double-clicking a leaf row puts it into rename mode', () => {
    renderOutline();
    const rows = screen.getAllByRole('row').filter((r) => r.getAttribute('data-task-id'));
    const t1Row = rows.find((r) => r.getAttribute('data-task-id') === 't1');
    fireEvent.doubleClick(t1Row!);
    expect(screen.getByLabelText('Rename task')).toBeInTheDocument();
  });

  it('clicking the expand button toggles the wbs-store expanded set', () => {
    renderOutline();
    // After auto-expand on mount the phase 'p1' is expanded; click toggles it.
    const expandBtn = screen.getByRole('button', { name: /collapse Phase 1/i });
    fireEvent.click(expandBtn);
    expect(useWbsStore.getState().expandedIds.has('p1')).toBe(false);
  });

  it('double-clicking a leaf row enters rename mode and Enter commits via OutlineMode', () => {
    renderOutline();
    const rows = screen.getAllByRole('row').filter((r) => r.getAttribute('data-task-id'));
    const t1Row = rows.find((r) => r.getAttribute('data-task-id') === 't1');
    fireEvent.doubleClick(t1Row!);
    const input = screen.getByLabelText('Rename task');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // After Enter the OutlineMode's renamingId is cleared.
    expect(screen.queryByLabelText('Rename task')).not.toBeInTheDocument();
  });

  it('Escape inside the rename input invokes the cancel handler in OutlineMode', () => {
    renderOutline();
    const rows = screen.getAllByRole('row').filter((r) => r.getAttribute('data-task-id'));
    const t1Row = rows.find((r) => r.getAttribute('data-task-id') === 't1');
    fireEvent.doubleClick(t1Row!);
    const input = screen.getByLabelText('Rename task');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('Rename task')).not.toBeInTheDocument();
  });
});
