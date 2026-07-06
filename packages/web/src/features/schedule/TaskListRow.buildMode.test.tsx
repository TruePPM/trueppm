/**
 * TaskListRow build-mode integration tests — exercise the new branches that
 * fire when a `<BuildModeProvider>` ancestor is present (issues #338/#339/
 * #341 gated by #349). The flag-off path is covered by the existing
 * TaskListRow.test.tsx.
 */
import { useMemo } from 'react';
import { screen, render, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const widths: ColumnWidths['widths'] = {
  wbs: 48, task: 220, dur: 60, start: 80, finish: 80, progress: 50, owner: 72,
};
const visible: ColumnWidths['visible'] = {
  wbs: true, task: true, dur: true, start: true, finish: true, progress: true, owner: true,
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
  convertToMilestone: ReturnType<typeof vi.fn>;
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
  convertToMilestone: vi.fn(),
  deleteTask: vi.fn(),
};

function Harness({
  task = baseTask,
  level = 2,
  capture,
}: {
  task?: Task;
  level?: number;
  capture: { current: Captured | null };
}) {
  const focus = useScheduleFocus();
  const api = useMemo<BuildModeApi>(
    () => ({
      focus,
      indent: stableSpies.indent,
      outdent: stableSpies.outdent,
      insertBelow: stableSpies.insertBelow,
      convertToMilestone: stableSpies.convertToMilestone,
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
    convertToMilestone: stableSpies.convertToMilestone,
    deleteTask: stableSpies.deleteTask,
  };
  return (
    <BuildModeProvider api={api}>
      <TaskListRow task={task} level={level} widths={widths} visible={visible} />
    </BuildModeProvider>
  );
}

function renderHarness(opts: { task?: Task; level?: number } = {}) {
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

  it('Tab on focused row triggers indent (Shift-Tab triggers outdent)', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    const row = screen.getByRole('row');
    fireEvent.keyDown(row, { key: 'Tab' });
    expect(c.current.indent).toHaveBeenCalledWith('t-build-1');
    fireEvent.keyDown(row, { key: 'Tab', shiftKey: true });
    expect(c.current.outdent).toHaveBeenCalledWith('t-build-1');
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

  it('F2 on focused row enters Name cell-edit (build-mode override)', () => {
    const c = renderHarness();
    act(() => c.current.focus.focusRow('t-build-1'));
    fireEvent.keyDown(screen.getByRole('row'), { key: 'F2' });
    expect(c.current.focus.state.mode).toBe('CellEdit');
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
          convertToMilestone: stableSpies.convertToMilestone,
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
        convertToMilestone: stableSpies.convertToMilestone,
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
          convertToMilestone: stableSpies.convertToMilestone,
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
        convertToMilestone: stableSpies.convertToMilestone,
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
          convertToMilestone: stableSpies.convertToMilestone,
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
      convertToMilestone: stableSpies.convertToMilestone,
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
