/**
 * TaskListRow build-mode integration tests — exercise the new branches that
 * fire when a `<BuildModeProvider>` ancestor is present (issues #338/#339/
 * #341 gated by #349). The flag-off path is covered by the existing
 * TaskListRow.test.tsx.
 */
import { useMemo } from 'react';
import { screen, render, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { TaskListRow } from './TaskListRow';
import { BuildModeProvider } from './buildMode/BuildModeContext';
import {
  useScheduleFocus,
  type BuildModeApi,
  type UseScheduleFocusReturn,
} from './buildMode';
import type { Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import { MemoryRouter } from 'react-router';
import { stubCoarsePointer, restoreCoarsePointer } from '@/test/coarsePointer';
import { useRowMetrics } from '@/hooks/useRowHeight';
import {
  NUDGE_SIZE_COARSE,
  NUDGE_SIZE_FINE,
  ROW_HEIGHT_COARSE,
  INSERT_DISC_SIZE,
  INSERT_LANE_GAP,
  INSERT_TAP_INSET_COARSE,
  INSERT_TAP_SIZE_COARSE,
  resolveInsertTapSize,
  resolveNudgeLaneWidth,
} from './scheduleConstants';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const widths: ColumnWidths['widths'] = {
  wbs: 48, task: 220, links: 76, dur: 60, start: 80, finish: 80, progress: 50, owner: 72,
};
const visible: ColumnWidths['visible'] = {
  wbs: true, task: true, links: true, dur: true, start: true, finish: true, progress: true, owner: true,
};

const baseTask: Task = {
  id: 't-build-1', wbs: '1.2', name: 'Foundation',
  start: '2026-04-05', finish: '2026-04-09',
  duration: 5, progress: 0, parentId: 't-build-0',
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
  status: 'NOT_STARTED', assignees: [], notes: '',
};

interface Captured {
  api: BuildModeApi;
  focus: UseScheduleFocusReturn;
  indent: ReturnType<typeof vi.fn>;
  outdent: ReturnType<typeof vi.fn>;
  insertBelow: ReturnType<typeof vi.fn>;
  insertAbove: ReturnType<typeof vi.fn>;
  insertChild: ReturnType<typeof vi.fn>;
  mergeIntoPreviousRow: ReturnType<typeof vi.fn>;
  isPristineNewRow: ReturnType<typeof vi.fn>;
  isCaretAtEndRow: ReturnType<typeof vi.fn>;
  clearCaretAtEndRow: ReturnType<typeof vi.fn>;
  convertToMilestone: ReturnType<typeof vi.fn>;
  duplicateSubtree: ReturnType<typeof vi.fn>;
  deleteTask: ReturnType<typeof vi.fn>;
}

// Module-scope spies — pinned across every Harness re-render so the menuItems
// closure in TaskListRow keeps pointing at the same mock instance after each
// contextMenu/state-change cycle. (vi.fn() inside the component body would be
// re-created every render and the closure would point at the prior instance.)
const stableSpies = {
  indent: vi.fn(),
  outdent: vi.fn(),
  insertBelow: vi.fn(),
  insertAbove: vi.fn(),
  insertChild: vi.fn(),
  mergeIntoPreviousRow: vi.fn(),
  isPristineNewRow: vi.fn(() => false),
  isCaretAtEndRow: vi.fn(() => false),
  clearCaretAtEndRow: vi.fn(),
  convertToMilestone: vi.fn(),
  duplicateSubtree: vi.fn(),
  deleteTask: vi.fn(),
};

function Harness({
  task = baseTask,
  level = 2,
  childCount,
  onMoveToRequest,
  visibleOverride,
  capture,
}: {
  task?: Task;
  level?: number;
  /** Structural children under this row — the Σ cell's noun and count (#3027). */
  childCount?: number;
  onMoveToRequest?: (taskId: string) => void;
  /** Column visibility for THIS render — #3026 needs a row with `wbs: false`. */
  visibleOverride?: typeof visible;
  capture: { current: Captured | null };
}) {
  const focus = useScheduleFocus();
  const api = useMemo<BuildModeApi>(
    () => ({
      focus,
      indent: stableSpies.indent,
      outdent: stableSpies.outdent,
      insertBelow: stableSpies.insertBelow,
      insertAbove: stableSpies.insertAbove,
      insertChild: stableSpies.insertChild,
      mergeIntoPreviousRow: stableSpies.mergeIntoPreviousRow,
      isPristineNewRow: stableSpies.isPristineNewRow,
      isCaretAtEndRow: stableSpies.isCaretAtEndRow,
      clearCaretAtEndRow: stableSpies.clearCaretAtEndRow,
      convertToMilestone: stableSpies.convertToMilestone,
      duplicateSubtree: stableSpies.duplicateSubtree,
      deleteTask: stableSpies.deleteTask,
      isMutationPending: () => false,
    }),
    [focus],
  );
  capture.current = {
    api,
    focus,
    indent: stableSpies.indent,
    outdent: stableSpies.outdent,
    insertBelow: stableSpies.insertBelow,
    insertAbove: stableSpies.insertAbove,
    insertChild: stableSpies.insertChild,
    mergeIntoPreviousRow: stableSpies.mergeIntoPreviousRow,
    isPristineNewRow: stableSpies.isPristineNewRow,
    isCaretAtEndRow: stableSpies.isCaretAtEndRow,
    clearCaretAtEndRow: stableSpies.clearCaretAtEndRow,
    convertToMilestone: stableSpies.convertToMilestone,
    duplicateSubtree: stableSpies.duplicateSubtree,
    deleteTask: stableSpies.deleteTask,
  };
  return (
    <BuildModeProvider api={api}>
      <PanelStandIn
        task={task}
        level={level}
        childCount={childCount}
        visible={visibleOverride ?? visible}
        onMoveToRequest={onMoveToRequest}
      />
    </BuildModeProvider>
  );
}

/**
 * Plays `TaskListPanel`'s one structural role for these tests: resolving the
 * ⇤/⇥ lane and handing it down (#3026).
 *
 * The row has no fallback — a lane it renders without the panel reserving is a
 * row whose columns sit a lane right of their own headings — so a harness that
 * omits `nudgeReserve` is testing a row with no structural controls at all.
 * Resolving it the way the panel does (`resolveNudgeLaneWidth` off the live
 * pointer class) also means these tests exercise the same arithmetic production
 * does rather than a literal that can drift away from it.
 */
function PanelStandIn({
  task,
  level,
  childCount,
  visible: visibleProp,
  onMoveToRequest,
}: {
  task: Task;
  level: number;
  childCount?: number;
  visible: typeof visible;
  onMoveToRequest?: (taskId: string) => void;
}) {
  const { coarse } = useRowMetrics();
  return (
    <TaskListRow
      task={task}
      level={level}
      childCount={childCount}
      widths={widths}
      visible={visibleProp}
      nudgeReserve={resolveNudgeLaneWidth(coarse)}
      onMoveToRequest={onMoveToRequest}
    />
  );
}

function renderHarness(
  opts: {
    task?: Task;
    level?: number;
    childCount?: number;
    onMoveToRequest?: (taskId: string) => void;
    visibleOverride?: typeof visible;
  } = {},
) {
  const capture: { current: Captured | null } = { current: null };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={['/projects/p1/schedule']}>
      <QueryClientProvider client={qc}>
        <Harness {...opts} capture={capture} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return capture as { current: Captured };
}

describe('TaskListRow — build-mode keyboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clicking row calls focus.focusRow (instead of toggling scheduleStore selection)', () => {
    const c = renderHarness();
    fireEvent.click(screen.getByRole('row'));
    expect(c.current.focus.state.mode).toBe('RowFocused');
    expect(c.current.focus.state.rowId).toBe('t-build-1');
  });

  it('Alt+Right on focused row triggers indent (Alt+Left triggers outdent) — #2727', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    const row = screen.getByRole('row');
    fireEvent.keyDown(row, { key: 'ArrowRight', altKey: true });
    expect(c.current.indent).toHaveBeenCalledWith('t-build-1');
    fireEvent.keyDown(row, { key: 'ArrowLeft', altKey: true });
    expect(c.current.outdent).toHaveBeenCalledWith('t-build-1');
  });

  // #2727 (ADR-0776 §6): plain Tab must NOT be intercepted on a focused row —
  // the old Tab=indent binding reproduced the WCAG 2.1.2 keyboard trap #2192
  // already fixed once in OutlineMode.tsx (every Tab prevented, no way to
  // leave the grid by keyboard). Regression guard mirroring
  // OutlineMode.test.tsx's equivalent assertion.
  it('plain Tab on a focused row is not intercepted (falls through to native focus traversal)', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    const row = screen.getByRole('row');
    const event = fireEvent.keyDown(row, { key: 'Tab' });
    expect(event).toBe(true); // not defaultPrevented
    expect(c.current.indent).not.toHaveBeenCalled();
    fireEvent.keyDown(row, { key: 'Tab', shiftKey: true });
    expect(c.current.outdent).not.toHaveBeenCalled();
  });

  it('Delete key on focused row triggers deleteTask', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    const row = screen.getByRole('row');
    fireEvent.keyDown(row, { key: 'Delete' });
    expect(c.current.deleteTask).toHaveBeenCalledWith('t-build-1');
  });

  it('Backspace on focused row triggers deleteTask', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'Backspace' });
    expect(c.current.deleteTask).toHaveBeenCalledWith('t-build-1');
  });

  it('Esc on focused row clears focus', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'Escape' });
    expect(c.current.focus.state.mode).toBe('NoSelection');
  });

  it('letter key on focused row enters Name cell-edit', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'a' });
    expect(c.current.focus.state.mode).toBe('CellEdit');
    expect(c.current.focus.state.column).toBe('name');
  });

  it('Enter on focused row inserts a sibling below via insertBelow (#1666)', () => {
    // Enter no longer opens cell-edit (that is now F2 / double-click / letter) —
    // it creates a new sibling row. The insertBelow API handles focusing the
    // new row's Name cell on create success.
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'Enter' });
    expect(c.current.insertBelow).toHaveBeenCalledWith('t-build-1');
  });

  it('Shift+Enter on focused row inserts a sibling above via insertAbove (#2727)', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'Enter', shiftKey: true });
    expect(c.current.insertAbove).toHaveBeenCalledWith('t-build-1');
    expect(c.current.insertBelow).not.toHaveBeenCalled();
  });

  it('⌘+Enter on focused row inserts a child via insertChild (#2727)', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'Enter', metaKey: true });
    expect(c.current.insertChild).toHaveBeenCalledWith('t-build-1');
    expect(c.current.insertBelow).not.toHaveBeenCalled();
  });

  it('Ctrl+Enter on focused row also inserts a child via insertChild (#2727)', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'Enter', ctrlKey: true });
    expect(c.current.insertChild).toHaveBeenCalledWith('t-build-1');
  });

  it('F2 on focused row enters Name cell-edit (build-mode override)', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'F2' });
    expect(c.current.focus.state.mode).toBe('CellEdit');
  });

  it('Backspace on an emptied Name cell calls mergeIntoPreviousRow (#2727)', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'F2' });
    const input = screen.getByLabelText(/Rename task/i);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(c.current.mergeIntoPreviousRow).toHaveBeenCalledWith('t-build-1');
  });

  it('Backspace on a non-empty Name cell does NOT call mergeIntoPreviousRow', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'F2' });
    const input = screen.getByLabelText(/Rename task/i);
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(c.current.mergeIntoPreviousRow).not.toHaveBeenCalled();
  });

  it('Esc on a pristine (just-created, never-touched) row discards it via deleteTask (#2727)', () => {
    stableSpies.isPristineNewRow.mockReturnValue(true);
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'F2' });
    const input = screen.getByLabelText(/Rename task/i);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(c.current.deleteTask).toHaveBeenCalledWith('t-build-1');
  });

  it('Esc on a non-pristine row reverts to its last committed value (no delete)', () => {
    stableSpies.isPristineNewRow.mockReturnValue(false);
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'F2' });
    const input = screen.getByLabelText(/Rename task/i);
    fireEvent.change(input, { target: { value: 'Something typed' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(c.current.deleteTask).not.toHaveBeenCalled();
    expect(c.current.focus.state.mode).toBe('RowFocused');
  });

  it('double-click on row jumps directly into Name cell-edit', () => {
    const c = renderHarness();
    fireEvent.doubleClick(screen.getByRole('row'));
    expect(c.current.focus.state.mode).toBe('CellEdit');
    expect(c.current.focus.state.column).toBe('name');
  });

  it('ArrowDown on focused row moves focus to nextTaskId (#360)', () => {
    const capture: { current: Captured | null } = { current: null };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper() {
      const focus = useScheduleFocus();
      const api = useMemo<BuildModeApi>(
        () => ({
          focus,
          indent: stableSpies.indent,
          outdent: stableSpies.outdent,
          insertBelow: stableSpies.insertBelow,
          insertAbove: stableSpies.insertAbove,
          insertChild: stableSpies.insertChild,
          mergeIntoPreviousRow: stableSpies.mergeIntoPreviousRow,
          isPristineNewRow: stableSpies.isPristineNewRow,
          isCaretAtEndRow: stableSpies.isCaretAtEndRow,
          clearCaretAtEndRow: stableSpies.clearCaretAtEndRow,
          convertToMilestone: stableSpies.convertToMilestone,
          duplicateSubtree: stableSpies.duplicateSubtree,
          deleteTask: stableSpies.deleteTask,
          isMutationPending: () => false,
        }),
        [focus],
      );
      capture.current = {
        api, focus,
        indent: stableSpies.indent,
        outdent: stableSpies.outdent,
        insertBelow: stableSpies.insertBelow,
        insertAbove: stableSpies.insertAbove,
        insertChild: stableSpies.insertChild,
        mergeIntoPreviousRow: stableSpies.mergeIntoPreviousRow,
        isPristineNewRow: stableSpies.isPristineNewRow,
        isCaretAtEndRow: stableSpies.isCaretAtEndRow,
        clearCaretAtEndRow: stableSpies.clearCaretAtEndRow,
        convertToMilestone: stableSpies.convertToMilestone,
        duplicateSubtree: stableSpies.duplicateSubtree,
        deleteTask: stableSpies.deleteTask,
      };
      const second: Task = { ...baseTask, id: 't-build-2', wbs: '1.3', name: 'Roof' };
      return (
        <BuildModeProvider api={api}>
          <TaskListRow task={baseTask} level={2} widths={widths} visible={visible} nextTaskId="t-build-2" />
          <TaskListRow task={second} level={2} widths={widths} visible={visible} prevTaskId="t-build-1" />
        </BuildModeProvider>
      );
    }
    render(
      <MemoryRouter initialEntries={['/projects/p1/schedule']}>
        <QueryClientProvider client={qc}>
          <Wrapper />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const c = capture as { current: Captured };
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getAllByRole('row')[0], { key: 'ArrowDown' });
    expect(c.current.focus.state.rowId).toBe('t-build-2');
  });

  it('ArrowUp on focused row moves focus to prevTaskId (#360)', () => {
    const capture: { current: Captured | null } = { current: null };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper() {
      const focus = useScheduleFocus();
      const api = useMemo<BuildModeApi>(
        () => ({
          focus,
          indent: stableSpies.indent,
          outdent: stableSpies.outdent,
          insertBelow: stableSpies.insertBelow,
          insertAbove: stableSpies.insertAbove,
          insertChild: stableSpies.insertChild,
          mergeIntoPreviousRow: stableSpies.mergeIntoPreviousRow,
          isPristineNewRow: stableSpies.isPristineNewRow,
          isCaretAtEndRow: stableSpies.isCaretAtEndRow,
          clearCaretAtEndRow: stableSpies.clearCaretAtEndRow,
          convertToMilestone: stableSpies.convertToMilestone,
          duplicateSubtree: stableSpies.duplicateSubtree,
          deleteTask: stableSpies.deleteTask,
          isMutationPending: () => false,
        }),
        [focus],
      );
      capture.current = {
        api, focus,
        indent: stableSpies.indent,
        outdent: stableSpies.outdent,
        insertBelow: stableSpies.insertBelow,
        insertAbove: stableSpies.insertAbove,
        insertChild: stableSpies.insertChild,
        mergeIntoPreviousRow: stableSpies.mergeIntoPreviousRow,
        isPristineNewRow: stableSpies.isPristineNewRow,
        isCaretAtEndRow: stableSpies.isCaretAtEndRow,
        clearCaretAtEndRow: stableSpies.clearCaretAtEndRow,
        convertToMilestone: stableSpies.convertToMilestone,
        duplicateSubtree: stableSpies.duplicateSubtree,
        deleteTask: stableSpies.deleteTask,
      };
      const first: Task = { ...baseTask, id: 't-build-0', wbs: '1.1', name: 'Site prep' };
      return (
        <BuildModeProvider api={api}>
          <TaskListRow task={first} level={2} widths={widths} visible={visible} nextTaskId="t-build-1" />
          <TaskListRow task={baseTask} level={2} widths={widths} visible={visible} prevTaskId="t-build-0" />
        </BuildModeProvider>
      );
    }
    render(
      <MemoryRouter initialEntries={['/projects/p1/schedule']}>
        <QueryClientProvider client={qc}>
          <Wrapper />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const c = capture as { current: Captured };
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getAllByRole('row')[1], { key: 'ArrowUp' });
    expect(c.current.focus.state.rowId).toBe('t-build-0');
  });

  it('Ctrl+letter is NOT treated as letter-key entry (modifier check)', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'a', ctrlKey: true });
    expect(c.current.focus.state.mode).toBe('RowFocused');
  });
});

describe('TaskListRow — build-mode context menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('right-click opens row menu and focuses the row', () => {
    const c = renderHarness();
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    expect(screen.getByRole('menu', { name: 'Row actions' })).toBeInTheDocument();
    expect(c.current.focus.state.rowId).toBe('t-build-1');
  });

  it('menu Edit item enters Name cell-edit', () => {
    const c = renderHarness();
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit/ }));
    expect(c.current.focus.state.mode).toBe('CellEdit');
    expect(c.current.focus.state.column).toBe('name');
  });

  it('menu Indent item triggers indent mutation', () => {
    const c = renderHarness();
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Indent/ }));
    expect(c.current.indent).toHaveBeenCalledWith('t-build-1');
  });

  it('menu Outdent item triggers outdent mutation', () => {
    const c = renderHarness();
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Outdent/ }));
    expect(c.current.outdent).toHaveBeenCalledWith('t-build-1');
  });

  it('menu Convert-to-milestone item triggers convertToMilestone', () => {
    const c = renderHarness();
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Convert to milestone/ }));
    expect(c.current.convertToMilestone).toHaveBeenCalledWith('t-build-1');
  });

  it('menu Delete item triggers deleteTask', () => {
    const c = renderHarness();
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    expect(c.current.deleteTask).toHaveBeenCalledWith('t-build-1');
  });

  it('Outdent is disabled at root level (level=1)', () => {
    renderHarness({ level: 1 });
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    const outdentItem = screen.getByRole('menuitem', { name: /Outdent/ });
    expect(outdentItem).toBeDisabled();
  });

  it('Insert below is dropped from the menu entirely (ADR-0066 ux-design)', () => {
    // Previously the item rendered greyed out. The redesign drops it from the
    // menu until a positioned-insert API exists; the cheatsheet still documents
    // the "Enter on empty row → new row below" path in build mode.
    renderHarness();
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    expect(screen.queryByRole('menuitem', { name: /Insert below/ })).toBeNull();
  });

  it('Mark complete appears between Edit and Indent (#477)', () => {
    renderHarness();
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    expect(screen.getByRole('menuitem', { name: /Mark complete/ })).toBeInTheDocument();
  });

  it('Mark complete label flips to Unmark complete when status is COMPLETE', () => {
    renderHarness({ task: { ...baseTask, status: 'COMPLETE' } });
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    expect(screen.getByRole('menuitem', { name: /Unmark complete/ })).toBeInTheDocument();
  });

  it('Mark complete is disabled on milestone rows', () => {
    renderHarness({ task: { ...baseTask, isMilestone: true, duration: 0 } });
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    expect(screen.getByRole('menuitem', { name: /Mark complete/ })).toBeDisabled();
  });

  it('Add predecessor / Add successor / Duplicate items render (#477)', () => {
    renderHarness();
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    expect(screen.getByRole('menuitem', { name: /Add predecessor/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Add successor/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Duplicate/ })).toBeInTheDocument();
  });

  it('Convert to milestone is disabled when task is already a milestone', () => {
    renderHarness({ task: { ...baseTask, isMilestone: true, duration: 0 } });
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    const item = screen.getByRole('menuitem', { name: /Convert to milestone/ });
    expect(item).toBeDisabled();
  });

  // ── "Move to…" (#2954) ───────────────────────────────────────────────────
  // Drag can move a row under ANY phase; ⌥→/⌥← can only step one level against
  // the row above. Without this item the drag would be the sole route to that
  // capability, which is a WCAG 2.1.1 failure — and on touch it is the route
  // that needs no drag at all.

  it('offers Move to… next to Indent and Outdent', () => {
    renderHarness({ onMoveToRequest: vi.fn() });
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    expect(screen.getByRole('menuitem', { name: /Move to/ })).toBeInTheDocument();
  });

  it('Move to… opens the picker for THIS row', () => {
    const onMoveToRequest = vi.fn();
    renderHarness({ onMoveToRequest });
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Move to/ }));
    expect(onMoveToRequest).toHaveBeenCalledWith('t-build-1');
  });

  it('Move to… is disabled where no picker is wired, not silently inert', () => {
    renderHarness();
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    expect(screen.getByRole('menuitem', { name: /Move to/ })).toBeDisabled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #806 — right-click suppression while a structural mutation is in flight.
// Deleting a row that has an open context menu (or that is right-clicked
// during the delete window) orphans the BuildModeRowMenu portal when the row
// unmounts on cache invalidation. The two guards below prevent that orphan.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — pending-mutation guards (#806)', () => {
  function renderWithPending(pendingIds: Set<string>) {
    const capture: { current: { focus: UseScheduleFocusReturn } | null } = { current: null };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ ids }: { ids: Set<string> }) {
      const focus = useScheduleFocus();
      const api = useMemo<BuildModeApi>(
        () => ({
          focus,
          indent: stableSpies.indent,
          outdent: stableSpies.outdent,
          insertBelow: stableSpies.insertBelow,
          insertAbove: stableSpies.insertAbove,
          insertChild: stableSpies.insertChild,
          mergeIntoPreviousRow: stableSpies.mergeIntoPreviousRow,
          isPristineNewRow: stableSpies.isPristineNewRow,
          isCaretAtEndRow: stableSpies.isCaretAtEndRow,
          clearCaretAtEndRow: stableSpies.clearCaretAtEndRow,
          convertToMilestone: stableSpies.convertToMilestone,
          duplicateSubtree: stableSpies.duplicateSubtree,
          deleteTask: stableSpies.deleteTask,
          isMutationPending: (id: string) => ids.has(id),
        }),
        [focus, ids],
      );
      capture.current = { focus };
      return (
        <BuildModeProvider api={api}>
          <TaskListRow task={baseTask} level={2} widths={widths} visible={visible} />
        </BuildModeProvider>
      );
    }
    const utils = render(
      <MemoryRouter initialEntries={['/projects/p1/schedule']}>
        <QueryClientProvider client={qc}>
          <Wrapper ids={pendingIds} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    return { capture: capture as { current: { focus: UseScheduleFocusReturn } }, ...utils };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('right-click is suppressed while this row has a pending mutation', () => {
    renderWithPending(new Set(['t-build-1']));
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    expect(screen.queryByRole('menu', { name: 'Row actions' })).toBeNull();
  });

  it('open menu auto-closes when the row transitions into a pending state', () => {
    // Render without pending → open menu → re-render with pending → menu closes.
    const { rerender } = render(
      <MemoryRouter initialEntries={['/projects/p1/schedule']}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <PendingHarness pending={false} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 50, clientY: 50 });
    expect(screen.getByRole('menu', { name: 'Row actions' })).toBeInTheDocument();
    rerender(
      <MemoryRouter initialEntries={['/projects/p1/schedule']}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <PendingHarness pending={true} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('menu', { name: 'Row actions' })).toBeNull();
  });
});

function PendingHarness({ pending }: { pending: boolean }) {
  const focus = useScheduleFocus();
  const api = useMemo<BuildModeApi>(
    () => ({
      focus,
      indent: stableSpies.indent,
      outdent: stableSpies.outdent,
      insertBelow: stableSpies.insertBelow,
      insertAbove: stableSpies.insertAbove,
      insertChild: stableSpies.insertChild,
      mergeIntoPreviousRow: stableSpies.mergeIntoPreviousRow,
      isPristineNewRow: stableSpies.isPristineNewRow,
      isCaretAtEndRow: stableSpies.isCaretAtEndRow,
      clearCaretAtEndRow: stableSpies.clearCaretAtEndRow,
      convertToMilestone: stableSpies.convertToMilestone,
      duplicateSubtree: stableSpies.duplicateSubtree,
      deleteTask: stableSpies.deleteTask,
      isMutationPending: (id: string) => pending && id === 't-build-1',
    }),
    [focus, pending],
  );
  return (
    <BuildModeProvider api={api}>
      <TaskListRow task={baseTask} level={2} widths={widths} visible={visible} />
    </BuildModeProvider>
  );
}

describe('TaskListRow — build-mode editable cells', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clicking the Dur cell on a non-milestone enters duration cell-edit', () => {
    const c = renderHarness();
    const durCell = screen.getByLabelText(/Duration: 5 days/);
    fireEvent.click(durCell);
    expect(c.current.focus.state.mode).toBe('CellEdit');
    expect(c.current.focus.state.column).toBe('duration');
  });

  it('clicking the % cell on a non-milestone enters progress cell-edit', () => {
    const c = renderHarness();
    const pctCell = screen.getByLabelText(/Progress: 0%/);
    fireEvent.click(pctCell);
    expect(c.current.focus.state.mode).toBe('CellEdit');
    expect(c.current.focus.state.column).toBe('progress');
  });

  it('milestone tasks fall through to the static Dur cell (no EditableCell)', () => {
    renderHarness({ task: { ...baseTask, isMilestone: true, duration: 0 } });
    // Static cell uses the legacy aria-label "milestone".
    expect(screen.getByLabelText('milestone')).toBeInTheDocument();
  });
});

describe('TaskListRow — structure controls at the WBS number (#2956)', () => {
  beforeEach(() => vi.clearAllMocks());

  // The controls are gated on edit rights (web rule 302, #2949) — the harness
  // has no project role, so the server-declared per-task flag is what turns
  // them on here.
  const editable: Task = { ...baseTask, canEdit: true };

  it('offers indent and outdent on the row itself, not only from a menu', () => {
    // Restructuring must not be keyboard-or-right-click-only knowledge.
    renderHarness({ task: editable });
    expect(screen.getByRole('button', { name: /Indent Foundation/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Outdent Foundation/ })).toBeInTheDocument();
  });

  it('states the consequence in the accessible name, not the mechanism', () => {
    renderHarness({ task: editable });
    expect(
      screen.getByRole('button', { name: 'Indent Foundation — move it under the row above' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Outdent Foundation — move it out of its phase' }),
    ).toBeInTheDocument();
  });

  it('calls the same build-mode operations the keyboard does', () => {
    renderHarness({ task: editable });
    fireEvent.click(screen.getByRole('button', { name: /Indent Foundation/ }));
    expect(stableSpies.indent).toHaveBeenCalledWith('t-build-1');
    fireEvent.click(screen.getByRole('button', { name: /Outdent Foundation/ }));
    expect(stableSpies.outdent).toHaveBeenCalledWith('t-build-1');
  });

  it('disables outdent at the top level rather than moving a root row nowhere', () => {
    renderHarness({ task: editable, level: 1 });
    expect(screen.getByRole('button', { name: /Outdent Foundation/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Indent Foundation/ })).toBeEnabled();
  });

  it('keeps the pair away from delete — they are not neighbours in the tab order either', () => {
    // A structural nudge and a destructive act must not sit next to each other;
    // mis-hitting one must never cost the other. The buttons live in the WBS
    // cell and are skipped by Tab (tabIndex -1), reached by the row's own keys.
    renderHarness({ task: editable });
    expect(screen.getByRole('button', { name: /Indent Foundation/ })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('gives a viewer no structure controls at all — absent, not disabled (rule 302)', () => {
    renderHarness({ task: { ...baseTask, canEdit: false } });
    expect(screen.queryByRole('button', { name: /Indent Foundation/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Outdent Foundation/ })).not.toBeInTheDocument();
  });
});

/**
 * #3026 — the pair degraded two ways, and both defeat the reason it exists.
 *
 * The design's own justification for putting indent/outdent on the row is that
 * "restructuring is not keyboard-only knowledge". A control that disappears with
 * an unrelated column, or that is a 16px target on a device with no keyboard,
 * fails that sentence rather than the aesthetic around it.
 */
describe('TaskListRow — the structural nudges survive a hidden WBS column (#3026)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(restoreCoarsePointer);

  const editable: Task = { ...baseTask, canEdit: true };
  const wbsHidden = { ...visible, wbs: false };

  it('still offers indent and outdent when the WBS column is switched off', () => {
    // THE defect. The pair used to live inside the WBS cell, which is rendered
    // `visible.wbs && …` — so a Display ▸ Columns preference that has nothing to
    // do with restructuring deleted both controls from every row, leaving
    // right-click as the only pointer route.
    renderHarness({ task: editable, visibleOverride: wbsHidden });
    expect(screen.queryByLabelText('WBS 1.2')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Indent Foundation/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Outdent Foundation/ })).toBeInTheDocument();
  });

  it('keeps them working, not merely present, with the column hidden', () => {
    // Present-but-inert would be the same defect with a nicer screenshot.
    renderHarness({ task: editable, visibleOverride: wbsHidden });
    fireEvent.click(screen.getByRole('button', { name: /Indent Foundation/ }));
    expect(stableSpies.indent).toHaveBeenCalledWith('t-build-1');
    fireEvent.click(screen.getByRole('button', { name: /Outdent Foundation/ }));
    expect(stableSpies.outdent).toHaveBeenCalledWith('t-build-1');
  });

  it('puts them in their OWN lane, not inside the WBS gridcell', () => {
    // The structural half of the fix: as long as the buttons are descendants of
    // the WBS cell, some future column change can delete them again.
    renderHarness({ task: editable });
    const wbsCell = screen.getByLabelText('WBS 1.2');
    const indent = screen.getByRole('button', { name: /Indent Foundation/ });
    expect(wbsCell.contains(indent)).toBe(false);
    expect(screen.getByTestId('row-structure-nudges').contains(indent)).toBe(true);
  });

  it('keeps the lane to the LEFT of the WBS number — never rightward toward delete', () => {
    // The design is explicit that a structural nudge and a destructive act must
    // not be neighbours (#2956). "Free it from the WBS column" must not be
    // solved by moving it across the row to the other controls.
    renderHarness({ task: editable });
    const row = screen.getByRole('row');
    const cells = Array.from(row.children);
    const lane = screen.getByTestId('row-structure-nudges');
    const wbsCell = screen.getByLabelText('WBS 1.2');
    expect(cells.indexOf(lane)).toBeGreaterThanOrEqual(0);
    expect(cells.indexOf(lane)).toBeLessThan(cells.indexOf(wbsCell));
  });
});

describe('TaskListRow — the nudges meet the touch floor on a coarse pointer (#3026)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(restoreCoarsePointer);

  const editable: Task = { ...baseTask, canEdit: true };

  it('sizes both buttons 44x44 on a coarse pointer', () => {
    // They were hard-coded `w-4 h-4` and did not grow at all: 16px targets
    // inside the 44px row #2997 shipped, on the surface whose stated reason to
    // exist is that restructuring must not be keyboard-only — for the user
    // (tablet) who has no keyboard. Web rule 5 / WCAG 2.5.5.
    stubCoarsePointer(true);
    renderHarness({ task: editable });
    for (const name of [/Indent Foundation/, /Outdent Foundation/]) {
      const btn = screen.getByRole('button', { name });
      expect(btn.style.width).toBe(`${NUDGE_SIZE_COARSE}px`);
      expect(btn.style.height).toBe(`${NUDGE_SIZE_COARSE}px`);
      expect(NUDGE_SIZE_COARSE).toBeGreaterThanOrEqual(44);
    }
  });

  it('takes the 44 from the ROW-HEIGHT owner, not a second literal (rule 315)', () => {
    // A second `44` in this file would agree with the row by luck. The moment
    // one moves, a control stops being as tall as its row and nothing looks
    // broken — which is the whole reason rule 315 is about ownership.
    expect(NUDGE_SIZE_COARSE).toBe(ROW_HEIGHT_COARSE);
  });

  it('leaves a mouse the compact 16px pair — no `md:` breakpoint in sight', () => {
    // The counterweight. A change that made every desktop row carry 44px nudges
    // would pass the assertion above and cost the planner a lane of the outline
    // they read the plan in.
    stubCoarsePointer(false);
    renderHarness({ task: editable });
    const btn = screen.getByRole('button', { name: /Indent Foundation/ });
    expect(btn.style.width).toBe(`${NUDGE_SIZE_FINE}px`);
    expect(btn.style.height).toBe(`${NUDGE_SIZE_FINE}px`);
  });

  it('gives the pair a lane wide enough for both targets, so neither covers the other', () => {
    // #2997: a 44px target that only reaches the floor by covering its neighbour
    // has not met the floor — it has moved the failure somewhere the tester will
    // not look. Two targets therefore cost two targets' width.
    stubCoarsePointer(true);
    renderHarness({ task: editable });
    const lane = screen.getByTestId('row-structure-nudges');
    expect(lane.style.width).toBe(`${resolveNudgeLaneWidth(true)}px`);
    expect(resolveNudgeLaneWidth(true)).toBeGreaterThanOrEqual(2 * 44);
  });

  it('sizes the lane to the full row height, not to the row minus its border', () => {
    // `inset-y-0` would make the lane `rowHeight - 1` — 43px, which has not met
    // a 44px floor however close it looks (the #2997 corollary).
    stubCoarsePointer(true);
    renderHarness({ task: editable });
    expect(screen.getByTestId('row-structure-nudges').style.height).toBe(`${ROW_HEIGHT_COARSE}px`);
  });
});

describe('TaskListRow — the lane does not land on top of the insert affordance (#3026)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(restoreCoarsePointer);

  const editable: Task = { ...baseTask, canEdit: true };

  /** Left edge of the `+`'s TAP box — the disc, less what `before:` overhangs. */
  function insertTapLeft(coarse: boolean): number {
    const insert = screen.getByRole('button', { name: /Insert an item below Foundation/ });
    const disc = Number.parseInt(insert.style.marginLeft, 10);
    return disc - (coarse ? INSERT_TAP_INSET_COARSE : 0);
  }

  it('clears the nudge lane with the TAP BOX, not merely with the disc', () => {
    // Two mistakes are available and the second is the subtle one. Omit the
    // nudge term and the 16px disc lands inside the ⇤/⇥ lane; include it but
    // clear only the disc, and the `before:-inset-3.5` box — what the browser
    // actually hit-tests — still covers the indent button's bottom-right 10px.
    //
    // Asserted as a clearance PROPERTY rather than by restating the offset
    // formula: a test that recomputes `lane + gap` agrees with the bug, and
    // jsdom renders no pseudo-element to measure instead.
    stubCoarsePointer(true);
    renderHarness({ task: editable, level: 1 });
    expect(insertTapLeft(true)).toBeGreaterThanOrEqual(resolveNudgeLaneWidth(true));
  });

  it('still clears it at depth, where the offset grows', () => {
    stubCoarsePointer(true);
    renderHarness({ task: editable, level: 4 });
    expect(insertTapLeft(true)).toBeGreaterThanOrEqual(resolveNudgeLaneWidth(true));
  });

  it('does not over-pay on a mouse, where no tap box is drawn at all', () => {
    // The `before:` box is coarse-only, so a fine pointer needs the visible
    // gutter and nothing more — pushing the disc 14px further right there would
    // be chrome bought for a box that does not exist.
    stubCoarsePointer(false);
    renderHarness({ task: editable, level: 1 });
    expect(insertTapLeft(false)).toBe(resolveNudgeLaneWidth(false) + INSERT_LANE_GAP);
  });
});

describe('TaskListRow — the nudges reserve their space at rest (#3026)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(restoreCoarsePointer);

  const editable: Task = { ...baseTask, canEdit: true };

  /** The element the resting-opacity treatment is actually on. */
  function ink(): HTMLElement {
    return screen.getByTestId('row-structure-nudges-ink');
  }

  it('rests at 32% opacity on a mouse rather than at zero', () => {
    // No test pinned this before, which is how a "tidy-up" to
    // `opacity-0 group-hover:opacity-100` would have landed green: identical in
    // a screenshot, and a row that shifts under the pointer on hover.
    stubCoarsePointer(false);
    renderHarness({ task: editable });
    expect(ink().className).toContain('opacity-[0.32]');
    expect(ink().className).not.toContain('opacity-0');
  });

  it('is at FULL strength on a coarse pointer — 32% would be the only state', () => {
    // There is no hover on a finger and both buttons are `tabIndex={-1}`, so
    // neither reveal path can fire: 32% of `neutral-text-secondary` is ≈1.6:1,
    // under WCAG 1.4.11's 3:1 for an active control. A 44px target nobody can
    // see is not a discoverable one — sizing it without showing it fixes the
    // measurable half of #3026 and leaves the half that matters.
    stubCoarsePointer(true);
    renderHarness({ task: editable });
    expect(ink().className).toContain('opacity-100');
    expect(ink().className).not.toContain('opacity-[0.32]');
  });

  it('brightens on ROW hover and on focus, WITHOUT re-laying-out the row', () => {
    // Only `opacity` transitions, and the buttons occupy their box at rest —
    // that pair of facts is what stops the FS/CP chips being shoved sideways
    // when the pointer crosses the row. A `transition-all`, or a display/width
    // branch, reintroduces the shift.
    //
    // `group-hover:`, not `group-hover/nudge:`: a reveal scoped to the 34px lane
    // needs the pointer already on the control, which is the discoverability
    // problem restated. The grip and the insert `+` both read the row's group.
    stubCoarsePointer(false);
    renderHarness({ task: editable });
    const cls = ink().className;
    expect(cls).toContain('group-hover:opacity-100');
    expect(cls).not.toContain('group-hover/nudge:');
    expect(cls).toContain('focus-within:opacity-100');
    expect(cls).toContain('transition-opacity');
    expect(cls).not.toContain('transition-all');
    expect(cls).not.toMatch(/\bhidden\b/);
  });

  it('keeps the populated lane a real gridcell — a row may not own bare buttons', () => {
    // The buttons used to live inside the WBS `role="gridcell"`. Freeing them
    // from that column must not cost the row its ARIA structure: `role="row"` in
    // a treegrid may own only gridcell / columnheader / rowheader.
    renderHarness({ task: editable });
    const lane = screen.getByTestId('row-structure-nudges');
    expect(lane).toHaveAttribute('role', 'gridcell');
    expect(lane).not.toHaveAttribute('aria-hidden');
    expect(lane.contains(screen.getByRole('button', { name: /Indent Foundation/ }))).toBe(true);
  });

});

describe('TaskListRow — insert lands where its position implies (#2957)', () => {
  beforeEach(() => vi.clearAllMocks());

  const editable: Task = { ...baseTask, canEdit: true };

  it('offers an insert affordance on the row itself', () => {
    renderHarness({ task: editable });
    expect(
      screen.getByRole('button', { name: /Insert an item below Foundation/ }),
    ).toBeInTheDocument();
  });

  it('says it lands below THIS row, at the same level', () => {
    // The old single "Add item" button sat at the foot of the list and inserted
    // at the cursor — a position that implied one thing and did another.
    renderHarness({ task: editable });
    expect(
      screen.getByRole('button', {
        name: 'Insert an item below Foundation, at the same level',
      }),
    ).toBeInTheDocument();
  });

  it('inserts below that row, not at the end of the plan', () => {
    renderHarness({ task: editable });
    fireEvent.click(screen.getByRole('button', { name: /Insert an item below Foundation/ }));
    expect(stableSpies.insertBelow).toHaveBeenCalledWith('t-build-1');
  });

  it('is absent without edit rights (rule 302)', () => {
    renderHarness({ task: { ...baseTask, canEdit: false } });
    expect(
      screen.queryByRole('button', { name: /Insert an item below/ }),
    ).not.toBeInTheDocument();
  });
});

describe('TaskListRow — the Σ cell (#2951)', () => {
  beforeEach(() => vi.clearAllMocks());

  const container: Task = { ...baseTask, canEdit: true, isSummary: true, duration: 19 };

  it('marks a rolled-up estimate rather than offering to edit it', () => {
    // The editable cell was offering a write the API refuses
    // (`phase_estimate_rollup_locked`) — a control that appears to override a
    // server-enforced rollup is a lie with a spinner.
    renderHarness({ task: container });
    const cell = screen.getByRole('gridcell', { name: /Estimate: 19 days/ });
    expect(cell).toHaveTextContent('Σ');
    expect(cell).toHaveTextContent('19d');
  });

  it('says where the number comes from, and what to change instead', () => {
    renderHarness({ task: container, childCount: 3 });
    // The noun is spelled out rather than swallowed by `.*`: the `.*` sat exactly
    // where `${childCount} ${noun}` renders, so reverting it to "tasks" left this
    // green. It is the one string in #3027 with a FACTUAL justification — a
    // container rolls up phases and milestones too — so it is the one that most
    // needs pinning.
    expect(
      screen.getByTitle('Rolls up from 3 items. Change an item to change this.'),
    ).toBeInTheDocument();
  });

  it('spells the rollup out in the accessible name, not just the Σ glyph', () => {
    renderHarness({ task: container, childCount: 3 });
    expect(
      screen.getByRole('gridcell', { name: /rolled up from 3 items\. Not editable here\./ }),
    ).toBeInTheDocument();
  });

  it('says ITEM, singular, when exactly one row rolls up', () => {
    // The singular branch had no test at all, and it is the branch a reviewer
    // is least likely to read: `childCount === 1 ? 'item' : 'items'` renders on
    // the one-child phase that is also the most common shape mid-build.
    renderHarness({ task: container, childCount: 1 });
    expect(
      screen.getByTitle('Rolls up from 1 item. Change an item to change this.'),
    ).toBeInTheDocument();
  });

  it('leaves a leaf task editable', () => {
    renderHarness({ task: { ...baseTask, canEdit: true } });
    expect(screen.queryByRole('gridcell', { name: /Estimate:/ })).not.toBeInTheDocument();
  });
});

describe('TaskListRow — the row-edge `+` meets the touch floor on a coarse pointer (#3029)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(restoreCoarsePointer);

  const editable: Task = { ...baseTask, canEdit: true };

  /** The `+` disc. Its accessible name is the vocabulary lock's wording (#3027). */
  function insertDisc(): HTMLElement {
    return screen.getByRole('button', { name: /Insert an item below Foundation/ });
  }

  it('takes the 44 from the ROW-HEIGHT owner, not a second literal (rule 315)', () => {
    // This is the whole defect. The tap box already measured 44px — but it got
    // there via a `before:-inset-3.5` Tailwind literal chosen because
    // `16 + 2 × 14` happens to equal the touch floor. That is the "agree by
    // luck" arrangement rule 315 exists to forbid: nothing connects it to the
    // row model, so a floor that moves grows the row and silently leaves this
    // target behind, with no visual symptom at all.
    expect(INSERT_TAP_SIZE_COARSE).toBe(ROW_HEIGHT_COARSE);
    expect(resolveInsertTapSize(true)).toBeGreaterThanOrEqual(44);
  });

  it('derives the inset from the disc and the box rather than declaring it', () => {
    // The box must stay centered on its mark. Deriving the overhang is what
    // makes that true by construction instead of by a matching pair of literals.
    expect(INSERT_TAP_INSET_COARSE).toBe((INSERT_TAP_SIZE_COARSE - INSERT_DISC_SIZE) / 2);
    expect(INSERT_DISC_SIZE + 2 * INSERT_TAP_INSET_COARSE).toBe(INSERT_TAP_SIZE_COARSE);
  });

  it('SIZES the box rather than insetting it — the two pixels jsdom cannot see', () => {
    // `before:-inset-3.5` measured 42px in a browser, not 44: an absolutely
    // positioned pseudo resolves `inset` against the PADDING box, and the disc's
    // 1px border sits inside its 16px border box under Preflight's `border-box`.
    // No assertion in this file could ever have caught that — jsdom renders no
    // pseudo geometry — so what is pinned here is the MECHANISM (an explicit
    // edge length, immune to the border) and the browser owns the measurement
    // (`e2e/schedule-coarse-row-height.spec.ts`).
    stubCoarsePointer(true);
    renderHarness({ task: editable });
    const disc = insertDisc();
    expect(disc.style.getPropertyValue('--insert-tap-size')).toBe(`${INSERT_TAP_SIZE_COARSE}px`);
    expect(disc.className).toContain('before:w-[var(--insert-tap-size)]');
    expect(disc.className).toContain('before:h-[var(--insert-tap-size)]');
    // The inset form, in any spelling, is the bug.
    expect(disc.className).not.toMatch(/before:-?inset/);
  });

  it('sizes the visible disc from the constant, not from a `w-4 h-4` literal', () => {
    // The disc and the inset are derived against each other; a Tailwind class
    // sizing the disc would put one of the pair back outside the owner.
    stubCoarsePointer(true);
    renderHarness({ task: editable });
    const disc = insertDisc();
    expect(disc.style.width).toBe(`${INSERT_DISC_SIZE}px`);
    expect(disc.style.height).toBe(`${INSERT_DISC_SIZE}px`);
    expect(disc.className).not.toMatch(/\bw-4\b/);
    expect(disc.className).not.toMatch(/\bh-4\b/);
  });

  it('DRAWS NO TAP BOX on a fine pointer — an unseen 44px target over rename is worse', () => {
    // The counterweight, and the decision this issue was split to record. On a
    // mouse the disc is hover-revealed, so a 44px `z-10` box around it would lie
    // invisibly over the row's name cell — the cell that takes inline rename and
    // F2 — and a planner clicking to rename would sometimes insert instead.
    // Option (a): the fine-pointer disc keeps its 16px box.
    stubCoarsePointer(false);
    renderHarness({ task: editable });
    const disc = insertDisc();
    expect(disc.className).not.toContain('before:absolute');
    expect(disc.className).not.toContain('before:w-[var(--insert-tap-size)]');
    expect(resolveInsertTapSize(false)).toBe(INSERT_DISC_SIZE);
  });

  it('leaves the fine-pointer reveal exactly as it was — hover and focus, not always-on', () => {
    // The hazard above only holds while the disc is hover-revealed. If this
    // assertion ever fails, the fine-pointer decision is back open (option (c)).
    stubCoarsePointer(false);
    renderHarness({ task: editable });
    const cls = insertDisc().className;
    expect(cls).toContain('opacity-0');
    expect(cls).toContain('group-hover:opacity-100');
    expect(cls).toContain('focus:opacity-100');
  });

  it('is permanently visible on a coarse pointer, so the 44px box is never unseen', () => {
    // The precondition that makes case 1 safe: there is no hover on a finger, so
    // a grown hit box is only honest if the mark under it is always shown.
    stubCoarsePointer(true);
    renderHarness({ task: editable });
    const cls = insertDisc().className;
    expect(cls).toContain('opacity-100');
    expect(cls).not.toContain('opacity-0');
  });
});
