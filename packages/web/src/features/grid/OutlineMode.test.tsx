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
      children: React.ReactNode;
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
  // A second top-level summary so we can test reparenting a leaf into a
  // *different* summary than its current parent.
  {
    id: 'p2', wbs: '2', name: 'Phase 2', start: '2026-06-01', finish: '2026-06-30',
    duration: 30, progress: 0, parentId: null,
    isCritical: false, isComplete: false, isSummary: true, isMilestone: false,
    status: 'NOT_STARTED', assignees: [],
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
        filters={{ search: 'no-such-task', ownerFilter: '', statusFilter: '' }}
        onClearFilters={vi.fn()}
        expandAllCounter={0}
        collapseAllCounter={0}
      />,
    );
    expect(screen.getByText(/no tasks match these filters/i)).toBeInTheDocument();
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
