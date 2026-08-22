/**
 * Web rule 302 at the row (#2961): a reader with no edit rights finds the
 * authoring apparatus **absent**, not disabled, and its refusals **silent**.
 *
 * The half that shipped in !1999 (#2949) was the toolbar. The row kept its
 * grips, structure cluster, insert points, delete and editable fields, so a
 * viewer still met a form someone had locked rather than a plan they could
 * read. These cases pin the row half.
 *
 * Two distinctions the suite exists to hold, because collapsing either is the
 * easy mistake:
 *
 *   * **no rights** vs **chose read-only**. Only the first gets absence; an
 *     editor in Read keeps the apparatus present and inert, because one key
 *     gets them back. That state lives in `ScheduleView`, not here.
 *   * **no rights** vs **not in build mode**. The row's mutation API is null in
 *     both cases, so gating on it alone would take the classic inline rename
 *     away from an editor who simply has not pressed ⌥A.
 *
 * The `role` mock is the whole fixture: 100 is Member, `null` is a reader with
 * no membership at all.
 */
import { useMemo, type ReactElement } from 'react';
import { screen, render, fireEvent } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useScheduleStore } from '@/stores/scheduleStore';
import { TaskListRow } from './TaskListRow';
import { BuildModeProvider } from './buildMode/BuildModeContext';
import { useScheduleFocus, type BuildModeApi } from './buildMode';
import type { Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';

const mocks = vi.hoisted(() => ({
  role: null as number | null,
  roleError: false,
  toggleMutate: vi.fn(),
  duplicateMutate: vi.fn(),
  updateMutate: vi.fn(),
  reorderMutate: vi.fn(),
  deleteTask: vi.fn(),
  indent: vi.fn(),
  outdent: vi.fn(),
  insertBelow: vi.fn(),
  enterCellEdit: vi.fn(),
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({
    role: mocks.role,
    roleLabel: null,
    isLoading: false,
    isError: mocks.roleError,
  }),
}));

vi.mock('@/hooks/useTaskMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTaskMutations')>();
  return {
    ...actual,
    useToggleComplete: () => ({ mutate: mocks.toggleMutate }) as never,
    useDuplicateTask: () => ({ mutate: mocks.duplicateMutate }) as never,
    useUpdateTask: () => ({ mutate: mocks.updateMutate, mutateAsync: vi.fn() }) as never,
    useReorderTasks: () => ({ mutate: mocks.reorderMutate }) as never,
  };
});

const widths: ColumnWidths['widths'] = {
  wbs: 48, task: 180, dur: 52, start: 74, finish: 74, progress: 52, owner: 72,
};
const visible: ColumnWidths['visible'] = {
  wbs: true, task: true, dur: true, start: true, finish: true, progress: true, owner: true,
};

const base: Task = {
  id: 't1', wbs: '1.1', name: 'Design Phase', start: '2026-10-05', finish: '2026-10-15',
  duration: 10, progress: 50, parentId: 't0',
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
  status: 'NOT_STARTED', assignees: [], notes: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = null;
  mocks.roleError = false;
  useScheduleStore.setState({ selectedTaskId: null, scheduleError: null });
});

function Harness({ task = base, siblingIds }: { task?: Task; siblingIds?: string[] }) {
  const focus = useScheduleFocus();
  const api = useMemo<BuildModeApi>(
    () => ({
      focus: { ...focus, enterCellEdit: mocks.enterCellEdit },
      indent: mocks.indent,
      outdent: mocks.outdent,
      insertBelow: mocks.insertBelow,
      insertAbove: vi.fn(),
      insertChild: vi.fn(),
      mergeIntoPreviousRow: vi.fn(),
      isCaretAtEndRow: () => false,
      clearCaretAtEndRow: vi.fn(),
      convertToMilestone: vi.fn(),
      duplicateSubtree: vi.fn(),
      deleteTask: mocks.deleteTask,
      isMutationPending: () => false,
    }),
    [focus],
  );
  return (
    <BuildModeProvider api={api}>
      <TaskListRow task={task} level={2} widths={widths} visible={visible} siblingIds={siblingIds} />
    </BuildModeProvider>
  );
}

function renderRow(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/projects/p1/schedule']}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/projects/:projectId/schedule" element={ui} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const renderBuild = (props: Parameters<typeof Harness>[0] = {}) =>
  renderRow(<Harness {...props} />);

// ───────────────────────────────────────────────────────────────────────────
// Absent, not disabled.
// ───────────────────────────────────────────────────────────────────────────
describe('no edit rights — the apparatus is absent', () => {
  it('renders no reorder grip', () => {
    renderBuild({ siblingIds: ['t1', 't2'] });
    expect(screen.queryByTitle(/Drag to reorder/i)).not.toBeInTheDocument();
  });

  it('renders no insert-below affordance', () => {
    renderBuild();
    expect(screen.queryByLabelText(/Insert an item below/i)).not.toBeInTheDocument();
  });

  it('renders no indent or outdent control', () => {
    renderBuild();
    expect(screen.queryByLabelText(/indent/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/outdent/i)).not.toBeInTheDocument();
  });

  it('renders the estimate as text, not a field', () => {
    renderBuild();
    // The editable cell advertises itself: "Press Enter to edit."
    expect(screen.queryByLabelText(/Press Enter to edit/i)).not.toBeInTheDocument();
    expect(screen.getByText('10d')).toBeInTheDocument();
  });

  it('leaves the apparatus present for a member — the mock is the only difference', () => {
    mocks.role = 100;
    renderBuild({ siblingIds: ['t1', 't2'] });
    expect(screen.getByTitle(/Drag to reorder/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Insert an item below/i)).toBeInTheDocument();
    // Several columns become editable cells at once — that they exist at all is
    // the assertion.
    expect(screen.getAllByLabelText(/Press Enter to edit/i).length).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Silent, not explained. Nothing offered the action, so there is no gesture
// left to explain.
// ───────────────────────────────────────────────────────────────────────────
describe('no edit rights — mutation gestures are silent no-ops', () => {
  it('Delete does not delete, and raises no error toast', () => {
    renderBuild();
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: 'Delete' });
    expect(mocks.deleteTask).not.toHaveBeenCalled();
    expect(useScheduleStore.getState().scheduleError).toBeNull();
  });

  it('Space does not toggle complete', () => {
    renderBuild();
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: ' ' });
    expect(mocks.toggleMutate).not.toHaveBeenCalled();
  });

  it('Cmd+D does not duplicate', () => {
    renderBuild();
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: 'd', metaKey: true });
    expect(mocks.duplicateMutate).not.toHaveBeenCalled();
  });

  it('Alt+Right does not indent', () => {
    renderBuild();
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowRight', altKey: true });
    expect(mocks.indent).not.toHaveBeenCalled();
  });

  it('a printable key does not open the name cell for editing', () => {
    renderBuild();
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: 'x' });
    expect(mocks.enterCellEdit).not.toHaveBeenCalled();
  });

  it('double-click does not start a rename', async () => {
    const user = userEvent.setup();
    renderBuild();
    await user.dblClick(screen.getByRole('row'));
    expect(mocks.enterCellEdit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/Rename task/i)).not.toBeInTheDocument();
  });

  it('right-click opens no row menu', () => {
    renderBuild();
    fireEvent.contextMenu(screen.getByRole('row'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// What survives is navigation. Absence removes what authors the plan, not
// what reads it — the failure mode of a one-line `buildMode = null` fix.
// ───────────────────────────────────────────────────────────────────────────
describe('no edit rights — navigation survives', () => {
  it('the row is still a focusable grid row', () => {
    renderBuild();
    const row = screen.getByRole('row');
    row.focus();
    expect(row).toHaveFocus();
  });

  it('Enter still selects the row', () => {
    renderBuild();
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(useScheduleStore.getState().selectedTaskId).toBe('t1');
    expect(mocks.insertBelow).not.toHaveBeenCalled();
  });

  it('the Properties button still opens the task drawer', () => {
    renderBuild();
    expect(screen.getByLabelText(/properties/i)).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The distinction that the obvious implementation loses.
// ───────────────────────────────────────────────────────────────────────────
describe('an editor outside build mode keeps the classic inline rename', () => {
  it('F2 still opens the flag-off rename for a member with no build mode', () => {
    mocks.role = 100;
    renderRow(<TaskListRow task={base} level={2} widths={widths} visible={visible} />);
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: 'F2' });
    expect(screen.getByLabelText(/Rename task/i)).toBeInTheDocument();
  });

  it('and a viewer outside build mode does not', () => {
    renderRow(<TaskListRow task={base} level={2} widths={widths} visible={visible} />);
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: 'F2' });
    expect(screen.queryByLabelText(/Rename task/i)).not.toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A failed lookup is UNKNOWN, not denial (#2961). The hook retries nothing, so
// before this the error case was indistinguishable from "settled: not a
// member" — one dropped request would strip an editor's whole apparatus, with
// no error state anywhere to explain where the controls went.
// ───────────────────────────────────────────────────────────────────────────
describe('a failed role lookup does not read as "no rights"', () => {
  it('keeps the apparatus when the membership request errored', () => {
    mocks.role = null;
    mocks.roleError = true;
    renderBuild({ siblingIds: ['t1', 't2'] });
    expect(screen.getByTitle(/Drag to reorder/i)).toBeInTheDocument();
  });

  it('still removes it for a settled non-member — the error flag is the only difference', () => {
    mocks.role = null;
    mocks.roleError = false;
    renderBuild({ siblingIds: ['t1', 't2'] });
    expect(screen.queryByTitle(/Drag to reorder/i)).not.toBeInTheDocument();
  });
});
