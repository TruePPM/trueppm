/**
 * Multi-row selection (#2727, ADR-0776 §1): Shift+↑/↓ extends a contiguous
 * range from the anchor, ⌘A selects siblings then the whole visible tree,
 * and structural keys (Backspace/Delete, Alt+→/←, Alt+↑/↓ move) act on every
 * selected row instead of just the anchor.
 *
 * Three rows: t-m1/t-m2 share parent t-m0 (siblings of each other); t-m3 has
 * a different parent (t-other) but is still visible immediately below them —
 * this lets the ⌘A "siblings vs whole tree" and Alt+↑/↓ "contiguous
 * same-parent only" tests distinguish "same parent" from "adjacent in the
 * visible list", which are deliberately different predicates in the ADR.
 */
import { useMemo } from 'react';
import { screen, render, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';

const reorderMutate = vi.fn();

vi.mock('@/hooks/useTaskMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTaskMutations')>();
  return {
    ...actual,
    useReorderTasks: () => ({ mutate: reorderMutate }) as never,
  };
});

const { TaskListRow } = await import('./TaskListRow');
const { BuildModeProvider } = await import('./buildMode/BuildModeContext');
const { useScheduleFocus } = await import('./buildMode');
type BuildModeApi = import('./buildMode').BuildModeApi;
type UseScheduleFocusReturn = import('./buildMode').UseScheduleFocusReturn;

const widths: ColumnWidths['widths'] = {
  wbs: 48, task: 220, dur: 60, start: 80, finish: 80, progress: 50, owner: 72,
};
const visible: ColumnWidths['visible'] = {
  wbs: true, task: true, dur: true, start: true, finish: true, progress: true, owner: true,
};

const baseFields = {
  start: '2026-04-05', finish: '2026-04-09',
  duration: 5, progress: 0,
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
  status: 'NOT_STARTED' as const, assignees: [], notes: '',
};

const TASK_1: Task = { ...baseFields, id: 't-m1', wbs: '1.1', name: 'One', parentId: 't-m0' };
const TASK_2: Task = { ...baseFields, id: 't-m2', wbs: '1.2', name: 'Two', parentId: 't-m0' };
const TASK_3: Task = { ...baseFields, id: 't-m3', wbs: '2.1', name: 'Three', parentId: 't-other' };

const SIBLING_IDS = ['t-m1', 't-m2'];
const VISIBLE_IDS = ['t-m1', 't-m2', 't-m3'];

const deleteTask = vi.fn();
const indent = vi.fn();
const outdent = vi.fn();

interface Capture {
  focus: UseScheduleFocusReturn;
}

function MultiSelectHarness({ capture }: { capture: { current: Capture | null } }) {
  const focus = useScheduleFocus();
  const api = useMemo<BuildModeApi>(
    () => ({
      focus,
      indent,
      outdent,
      insertBelow: vi.fn(),
      insertAbove: vi.fn(),
      insertChild: vi.fn(),
      mergeIntoPreviousRow: vi.fn(),
      isCaretAtEndRow: () => false,
      clearCaretAtEndRow: vi.fn(),
      convertToMilestone: vi.fn(),
      deleteTask,
      isMutationPending: () => false,
    }),
    [focus],
  );
  capture.current = { focus };
  return (
    <BuildModeProvider api={api}>
      <TaskListRow
        task={TASK_1}
        level={2}
        widths={widths}
        visible={visible}
        siblingIds={SIBLING_IDS}
        visibleTaskIds={VISIBLE_IDS}
        nextTaskId="t-m2"
      />
      <TaskListRow
        task={TASK_2}
        level={2}
        widths={widths}
        visible={visible}
        siblingIds={SIBLING_IDS}
        visibleTaskIds={VISIBLE_IDS}
        prevTaskId="t-m1"
        nextTaskId="t-m3"
      />
      <TaskListRow
        task={TASK_3}
        level={1}
        widths={widths}
        visible={visible}
        siblingIds={['t-m3']}
        visibleTaskIds={VISIBLE_IDS}
        prevTaskId="t-m2"
      />
    </BuildModeProvider>
  );
}

function renderHarness() {
  const capture: { current: Capture | null } = { current: null };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={['/projects/p1/schedule']}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route
            path="/projects/:projectId/schedule"
            element={<MultiSelectHarness capture={capture} />}
          />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return capture as { current: Capture };
}

describe('TaskListRow — Shift+↑/↓ selection extend (#2727, ADR-0776 §1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Shift+ArrowDown from the anchor selects the anchor and the next row', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'ArrowDown', shiftKey: true });
    expect(c.current.focus.state.selectedIds).toEqual(new Set(['t-m1', 't-m2']));
    expect(c.current.focus.state.rowId).toBe('t-m2');
  });

  it('a second Shift+ArrowDown grows the range from the same fixed anchor', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(screen.getAllByRole('row')[1], { key: 'ArrowDown', shiftKey: true });
    expect(c.current.focus.state.selectedIds).toEqual(new Set(['t-m1', 't-m2', 't-m3']));
  });

  it('Shift+ArrowUp then shrinks the range back toward the anchor', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(screen.getAllByRole('row')[1], { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(screen.getAllByRole('row')[2], { key: 'ArrowUp', shiftKey: true });
    expect(c.current.focus.state.selectedIds).toEqual(new Set(['t-m1', 't-m2']));
  });

  it('Shift+ArrowUp at the top of the visible list is a no-op (no prior row to extend to)', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'ArrowUp', shiftKey: true });
    expect(c.current.focus.state.selectedIds).toBeNull();
  });

  it('a plain ArrowDown (no shift) after extending collapses the selection back to one row', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(screen.getAllByRole('row')[1], { key: 'ArrowDown' });
    expect(c.current.focus.state.selectedIds).toBeNull();
    expect(c.current.focus.state.rowId).toBe('t-m3');
  });

  it('selected rows carry aria-selected once a range is active', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'ArrowDown', shiftKey: true });
    const rows = screen.getAllByRole('row');
    expect(rows[0]).toHaveAttribute('aria-selected', 'true');
    expect(rows[1]).toHaveAttribute('aria-selected', 'true');
    expect(rows[2]).toHaveAttribute('aria-selected', 'false');
  });
});

describe('TaskListRow — ⌘A select siblings then whole tree (#2727, ADR-0776 §1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('first ⌘A selects every sibling of the focused row', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'a', metaKey: true });
    expect(c.current.focus.state.selectedIds).toEqual(new Set(['t-m1', 't-m2']));
  });

  it('a second ⌘A while all siblings are selected expands to the whole visible tree', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'a', metaKey: true });
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'a', metaKey: true });
    expect(c.current.focus.state.selectedIds).toEqual(new Set(['t-m1', 't-m2', 't-m3']));
  });

  it('Ctrl+A behaves the same as ⌘A', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'a', ctrlKey: true });
    expect(c.current.focus.state.selectedIds).toEqual(new Set(['t-m1', 't-m2']));
  });
});

describe('TaskListRow — structural keys act on the whole selection (#2727, ADR-0776 §1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Delete with a multi-row selection deletes every selected row', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(screen.getAllByRole('row')[1], { key: 'Delete' });
    expect(deleteTask).toHaveBeenCalledWith('t-m1');
    expect(deleteTask).toHaveBeenCalledWith('t-m2');
    expect(deleteTask).toHaveBeenCalledTimes(2);
  });

  it('Backspace with no active selection still only deletes the focused row', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m2'));
    fireEvent.keyDown(screen.getAllByRole('row')[1], { key: 'Backspace' });
    expect(deleteTask).toHaveBeenCalledWith('t-m2');
    expect(deleteTask).toHaveBeenCalledTimes(1);
  });

  it('Alt+ArrowRight with a multi-row selection indents every selected row, top to bottom', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(screen.getAllByRole('row')[1], { key: 'ArrowRight', altKey: true });
    expect(indent).toHaveBeenNthCalledWith(1, 't-m1');
    expect(indent).toHaveBeenNthCalledWith(2, 't-m2');
  });

  it('Alt+ArrowLeft with a multi-row selection outdents every selected row', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(screen.getAllByRole('row')[1], { key: 'ArrowLeft', altKey: true });
    expect(outdent).toHaveBeenCalledWith('t-m1');
    expect(outdent).toHaveBeenCalledWith('t-m2');
  });
});

describe('TaskListRow — Alt+↑/↓ move is scoped to a contiguous same-parent selection (#2727, ADR-0776 §1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('moves a contiguous same-parent selection as one block', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'ArrowDown', shiftKey: true });
    // t-m1+t-m2 are both children of t-m0 — contiguous and same-parent within
    // their own sibling list — so Alt+ArrowDown may move the block.
    fireEvent.keyDown(screen.getAllByRole('row')[1], { key: 'ArrowDown', altKey: true });
    expect(reorderMutate).not.toHaveBeenCalled(); // no third same-parent sibling to swap with
  });

  it('is a no-op when the selection spans more than one parent', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-m1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'a', metaKey: true });
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'a', metaKey: true }); // whole tree: t-m1,t-m2,t-m3 (t-m3 has a different parent)
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'ArrowDown', altKey: true });
    expect(reorderMutate).not.toHaveBeenCalled();
  });

  it('with a third same-parent sibling, moves the contiguous block past it', () => {
    // A dedicated three-same-parent-sibling harness — SIBLING_IDS above only
    // has two entries, which is enough to prove the "no room to move"
    // no-op above but not enough to prove a real block move ever fires.
    const TRIO_SIBLING_IDS = ['t-x1', 't-x2', 't-x3'];
    const capture: { current: Capture | null } = { current: null };
    function TrioHarness() {
      const focus = useScheduleFocus();
      const api = useMemo<BuildModeApi>(
        () => ({
          focus,
          indent,
          outdent,
          insertBelow: vi.fn(),
          insertAbove: vi.fn(),
          insertChild: vi.fn(),
          mergeIntoPreviousRow: vi.fn(),
          isCaretAtEndRow: () => false,
          clearCaretAtEndRow: vi.fn(),
          convertToMilestone: vi.fn(),
          deleteTask,
          isMutationPending: () => false,
        }),
        [focus],
      );
      capture.current = { focus };
      const mk = (id: string, wbs: string): Task => ({
        ...baseFields, id, wbs, name: id, parentId: 't-x0',
      });
      return (
        <BuildModeProvider api={api}>
          <TaskListRow
            task={mk('t-x1', '1.1')}
            level={2}
            widths={widths}
            visible={visible}
            siblingIds={TRIO_SIBLING_IDS}
            visibleTaskIds={TRIO_SIBLING_IDS}
            nextTaskId="t-x2"
          />
          <TaskListRow
            task={mk('t-x2', '1.2')}
            level={2}
            widths={widths}
            visible={visible}
            siblingIds={TRIO_SIBLING_IDS}
            visibleTaskIds={TRIO_SIBLING_IDS}
            prevTaskId="t-x1"
            nextTaskId="t-x3"
          />
          <TaskListRow
            task={mk('t-x3', '1.3')}
            level={2}
            widths={widths}
            visible={visible}
            siblingIds={TRIO_SIBLING_IDS}
            visibleTaskIds={TRIO_SIBLING_IDS}
            prevTaskId="t-x2"
          />
        </BuildModeProvider>
      );
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={['/projects/p1/schedule']}>
        <QueryClientProvider client={qc}>
          <Routes>
            <Route path="/projects/:projectId/schedule" element={<TrioHarness />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const c = capture as { current: Capture };
    act(() => c.current.focus.focusRow('t-x1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(screen.getAllByRole('row')[1], { key: 'ArrowDown', altKey: true });
    expect(reorderMutate).toHaveBeenCalledWith({
      parent_path: '1',
      ordered_ids: ['t-x3', 't-x1', 't-x2'],
    });
  });
});
