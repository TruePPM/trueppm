/**
 * Behavior-coverage tests for the lower-covered TaskListRow surfaces that the
 * existing TaskListRow.test.tsx / .buildMode / .keyboardExtract suites don't
 * reach: the toggle-complete + duplicate mutation callbacks (success toast,
 * error rollback, active-sprint Undo), the milestone-rollup variance / scope-
 * change branches, the inline note / external-link / dependency chips, the
 * hover + dim row treatments, the hover-bus callbacks, auto-edit-on-mount, the
 * ⋮⋮ pointer-drag reorder, and the milestone start-cell date popover.
 *
 * The mutation hooks are mocked so the mutate callbacks are observable without
 * a live API, and toast is mocked so the "warm" celebration is assertable.
 */
import { useMemo, type ReactElement } from 'react';
import { screen, render, fireEvent, act } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, beforeEach, beforeAll, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithRouter } from '@/test/utils';
import { useScheduleStore } from '@/stores/scheduleStore';
import { TaskListRow } from './TaskListRow';
import { BuildModeProvider } from './buildMode/BuildModeContext';
import { useScheduleFocus, type BuildModeApi } from './buildMode';
import type { Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';

const mocks = vi.hoisted(() => ({
  toggleMutate: vi.fn(),
  duplicateMutate: vi.fn(),
  updateMutate: vi.fn(),
  updateMutateAsync: vi.fn(),
  reorderMutate: vi.fn(),
  warm: vi.fn(),
}));

vi.mock('@/hooks/useTaskMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTaskMutations')>();
  return {
    ...actual,
    useToggleComplete: () => ({ mutate: mocks.toggleMutate }) as never,
    useDuplicateTask: () => ({ mutate: mocks.duplicateMutate }) as never,
    useUpdateTask: () =>
      ({ mutate: mocks.updateMutate, mutateAsync: mocks.updateMutateAsync }) as never,
    useReorderTasks: () => ({ mutate: mocks.reorderMutate }) as never,
  };
});

vi.mock('@/components/Toast', () => ({
  toast: { warm: mocks.warm, error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

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

const tree = { hasChildren: false, isExpanded: false, onToggleId: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  useScheduleStore.setState({
    selectedTaskId: null,
    scheduleError: null,
    scheduleActionToast: null,
    revealGutterSprint: null,
  });
});

/** Render a row under a real `/projects/:projectId/...` route so useProjectId → 'p1'. */
function renderRouted(ui: ReactElement) {
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

// ───────────────────────────────────────────────────────────────────────────
// Mark complete (#477 / ADR-0066 Q5) — Space toggle mutation callbacks.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — handleToggleComplete (Space)', () => {
  it('Space fires the toggle mutation with the task snapshot and celebrates on success', () => {
    renderRouted(<TaskListRow task={base} level={1} widths={widths} visible={visible} />);
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: ' ' });

    expect(mocks.toggleMutate).toHaveBeenCalledTimes(1);
    const [vars, opts] = mocks.toggleMutate.mock.calls[0] as [
      Record<string, unknown>,
      { onSuccess: () => void; onError: (e: unknown) => void },
    ];
    expect(vars).toMatchObject({ id: 't1', projectId: 'p1', previousStatus: 'NOT_STARTED' });
    // NOT_STARTED → COMPLETE is a transition INTO complete: warm toast fires.
    act(() => opts.onSuccess());
    expect(mocks.warm).toHaveBeenCalledWith('Nice — Design Phase done.');
  });

  it('does NOT celebrate when un-completing an already-complete task', () => {
    renderRouted(
      <TaskListRow task={{ ...base, status: 'COMPLETE' }} level={1} widths={widths} visible={visible} />,
    );
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: ' ' });
    const [, opts] = mocks.toggleMutate.mock.calls[0] as [unknown, { onSuccess: () => void }];
    act(() => opts.onSuccess());
    expect(mocks.warm).not.toHaveBeenCalled();
  });

  it('surfaces a schedule error toast on the mutation error path', () => {
    renderRouted(<TaskListRow task={base} level={1} widths={widths} visible={visible} />);
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: ' ' });
    const [, opts] = mocks.toggleMutate.mock.calls[0] as [
      unknown,
      { onError: (e: unknown) => void },
    ];
    act(() => opts.onError(new Error('boom')));
    expect(useScheduleStore.getState().scheduleError).toBe('Failed to update task status.');
  });

  it('is a no-op on a milestone row (status toggling is meaningless on a date point)', () => {
    renderRouted(
      <TaskListRow task={{ ...base, isMilestone: true, duration: 0 }} level={1} widths={widths} visible={visible} />,
    );
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: ' ' });
    expect(mocks.toggleMutate).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no project id in scope', () => {
    // renderWithRouter mounts at "/", so useProjectId → undefined → projectId ''.
    renderWithRouter(<TaskListRow task={base} level={1} widths={widths} visible={visible} />);
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: ' ' });
    expect(mocks.toggleMutate).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Duplicate (#477 / ADR-0066 Q1/Q2) — success + active-sprint Undo + error.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — handleDuplicate (Ctrl+D)', () => {
  it('offers an Undo toast when the source is in an ACTIVE sprint, and Undo reverts to backlog', () => {
    renderRouted(
      <TaskListRow
        task={{ ...base, sprintId: 's1' }}
        level={1}
        widths={widths}
        visible={visible}
        siblingNames={['Design Phase']}
        sourceSprint={{ id: 's1', name: 'Sprint 4', state: 'ACTIVE' }}
      />,
    );
    fireEvent.keyDown(screen.getByRole('row'), { key: 'd', ctrlKey: true });

    expect(mocks.duplicateMutate).toHaveBeenCalledTimes(1);
    const [payload, opts] = mocks.duplicateMutate.mock.calls[0] as [
      Record<string, unknown>,
      { onSuccess: (created: { id: string }) => void },
    ];
    expect(payload).toMatchObject({ projectId: 'p1', source: { name: 'Design Phase' } });

    act(() => opts.onSuccess({ id: 'dup1' }));
    const toast = useScheduleStore.getState().scheduleActionToast;
    expect(toast?.message).toBe('Added to Sprint 4');
    expect(toast?.action?.label).toBe('Undo');

    // Activating Undo re-PATCHes the duplicate back to the backlog.
    act(() => toast!.action!.onClick());
    expect(mocks.updateMutate).toHaveBeenCalledWith({ id: 'dup1', projectId: 'p1', sprint: null });
    expect(useScheduleStore.getState().scheduleActionToast?.message).toBe('Moved to backlog');
  });

  it('does not offer an Undo toast when the source sprint is not ACTIVE', () => {
    renderRouted(
      <TaskListRow
        task={base}
        level={1}
        widths={widths}
        visible={visible}
        sourceSprint={{ id: 's1', name: 'Sprint 4', state: 'CLOSED' }}
      />,
    );
    fireEvent.keyDown(screen.getByRole('row'), { key: 'd', ctrlKey: true });
    const [, opts] = mocks.duplicateMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (created: { id: string }) => void },
    ];
    act(() => opts.onSuccess({ id: 'dup1' }));
    expect(useScheduleStore.getState().scheduleActionToast).toBeNull();
  });

  it('surfaces a schedule error toast on the duplicate error path', () => {
    renderRouted(<TaskListRow task={base} level={1} widths={widths} visible={visible} />);
    fireEvent.keyDown(screen.getByRole('row'), { key: 'd', ctrlKey: true });
    const [, opts] = mocks.duplicateMutate.mock.calls[0] as [unknown, { onError: () => void }];
    act(() => opts.onError());
    expect(useScheduleStore.getState().scheduleError).toBe('Failed to duplicate task.');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Milestone rollup cell variance / scope-change branches (ADR-0074, #551).
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — milestone rollup variance branches', () => {
  const milestone = (rollup: Task['milestoneRollup']): Task => ({
    ...base,
    isMilestone: true,
    duration: 0,
    progress: 0,
    totalFloat: 5,
    milestoneRollup: rollup,
  });

  it('renders an "ahead" variance in a non-critical tone', () => {
    renderWithRouter(
      <TaskListRow
        task={milestone({
          percent_complete: 40,
          rollup_basis: 'points',
          variance_days: -2,
          sprint_scope_changed: false,
          sprint_count: 1,
        })}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
      />,
    );
    // -2d ahead of plan, within float → amber annotation, negative label.
    expect(screen.getByText(/-2d/)).toBeInTheDocument();
    expect(screen.getByText('🔒')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('renders an on-plan (0d) variance in the neutral tone', () => {
    renderWithRouter(
      <TaskListRow
        task={milestone({
          percent_complete: 60,
          rollup_basis: 'tasks',
          variance_days: 0,
          sprint_scope_changed: false,
          sprint_count: 1,
        })}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
      />,
    );
    // On-plan variance renders "0d" (annotated with float) in the neutral tone.
    const chip = screen.getByText(/^0d/);
    expect(chip.className).toMatch(/text-neutral-text-secondary/);
  });

  it('omits the variance chip entirely when variance is null', () => {
    renderWithRouter(
      <TaskListRow
        task={milestone({
          percent_complete: 25,
          rollup_basis: 'points',
          variance_days: null,
          sprint_scope_changed: false,
          sprint_count: 1,
        })}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
      />,
    );
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.queryByText(/\dd/)).toBeNull();
  });

  it('renders the scope-changed chip when the linked sprint changed scope', () => {
    renderWithRouter(
      <TaskListRow
        task={milestone({
          percent_complete: 50,
          rollup_basis: 'points',
          variance_days: 1,
          sprint_scope_changed: true,
          scope_change_sprint_id: 's9',
          sprint_count: 1,
        })}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
      />,
    );
    expect(screen.getByRole('button', { name: /Scope changed/ })).toBeInTheDocument();
  });

  it('falls through to the empty read cell when rollup_basis is "none"', () => {
    renderWithRouter(
      <TaskListRow
        task={milestone({
          percent_complete: 80,
          rollup_basis: 'none',
          variance_days: null,
          sprint_scope_changed: false,
          sprint_count: 0,
        })}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
      />,
    );
    // No lock chrome; milestone read cell is empty (no percent text).
    expect(screen.queryByText('🔒')).toBeNull();
    expect(screen.getByLabelText('0% complete')).toHaveTextContent('');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Inline chips on the task name (note freshness, external links, dep chips).
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — inline chips', () => {
  it('renders the note-freshness chip when the task has a recent note', () => {
    renderWithRouter(
      <TaskListRow
        task={{ ...base, latestNoteAt: '2026-10-01T12:00:00Z' }}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
      />,
    );
    expect(screen.getByTestId('note-freshness-chip')).toBeInTheDocument();
  });

  it('renders the external-link chip with a pluralized count and worst-status tone', () => {
    renderWithRouter(
      <TaskListRow
        task={{ ...base, externalLinkSummary: { count: 3, worstStatus: 'closed' } }}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
      />,
    );
    const chip = screen.getByTestId('link-status-chip');
    expect(chip).toHaveTextContent('3');
    expect(chip).toHaveAttribute('aria-label', '3 external links, worst status: closed');
    expect(chip.className).toMatch(/text-semantic-critical/);
  });

  it('renders the external-link chip in the singular with no worst status', () => {
    renderWithRouter(
      <TaskListRow
        task={{ ...base, externalLinkSummary: { count: 1, worstStatus: null } }}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
      />,
    );
    const chip = screen.getByTestId('link-status-chip');
    expect(chip).toHaveAttribute('aria-label', '1 external link');
  });

  it('hides the external-link chip on summary tasks', () => {
    renderWithRouter(
      <TaskListRow
        task={{ ...base, isSummary: true, externalLinkSummary: { count: 2, worstStatus: 'open' } }}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
      />,
    );
    expect(screen.queryByTestId('link-status-chip')).toBeNull();
  });

  it('replaces assignee chips with dependency chips when selected in focus mode', () => {
    useScheduleStore.setState({ selectedTaskId: 't1' });
    // Owner column hidden so the only AssigneeChips would be the name-column one
    // that dep chips replace — its "A" initial must therefore be absent.
    renderWithRouter(
      <TaskListRow
        task={{ ...base, assignees: [{ resourceId: 'r1', name: 'Alice', units: 1 }] }}
        level={1}
        widths={widths}
        visible={{ ...visible, owner: false }}
        {...tree}
        depChips={{ predsCount: 2, succsCount: 1, predsCritical: true, succsCritical: false }}
      />,
    );
    expect(screen.getByLabelText('2 predecessors, 1 successors')).toBeInTheDocument();
    const preds = screen.getByText('←2');
    expect(preds.className).toMatch(/text-semantic-critical/);
    expect(screen.getByText('→1')).toBeInTheDocument();
    // Assignee initials chip is suppressed in favor of dep chips.
    expect(screen.queryByText('A')).toBeNull();
  });

  it('omits the predecessor chip when there are zero predecessors', () => {
    useScheduleStore.setState({ selectedTaskId: 't1' });
    renderWithRouter(
      <TaskListRow
        task={base}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
        depChips={{ predsCount: 0, succsCount: 2, predsCritical: false, succsCritical: true }}
      />,
    );
    expect(screen.queryByText(/←/)).toBeNull();
    expect(screen.getByText('→2')).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Row treatments: shared-hover wash (#2096) and focus-mode dim (#475).
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — hover + dim treatments', () => {
  it('applies the shared hover wash when isHovered is set', () => {
    renderWithRouter(
      <TaskListRow task={base} level={1} widths={widths} visible={visible} {...tree} isHovered />,
    );
    expect(screen.getByRole('row').className).toContain('bg-chrome-row-hover');
  });

  it('dims and disables pointer events for out-of-chain rows in focus mode', () => {
    renderWithRouter(
      <TaskListRow task={base} level={1} widths={widths} visible={visible} {...tree} dimmed />,
    );
    const row = screen.getByRole('row');
    expect(row.className).toContain('opacity-[0.22]');
    expect(row.className).toContain('pointer-events-none');
  });

  it('fires the hover bus on mouse enter/leave and keyboard focus', () => {
    const onHoverChange = vi.fn();
    renderWithRouter(
      <TaskListRow
        task={base}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
        onHoverChange={onHoverChange}
      />,
    );
    const row = screen.getByRole('row');
    fireEvent.mouseEnter(row);
    expect(onHoverChange).toHaveBeenLastCalledWith('t1');
    fireEvent.mouseLeave(row);
    expect(onHoverChange).toHaveBeenLastCalledWith(null);
    fireEvent.focus(row);
    expect(onHoverChange).toHaveBeenLastCalledWith('t1');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// "+ Phase" auto-edit on mount (issue #1754).
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — startInlineEditOnMount', () => {
  it('drops straight into inline rename and reports consumption exactly once', () => {
    const onAutoEditConsumed = vi.fn();
    renderWithRouter(
      <TaskListRow
        task={base}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
        startInlineEditOnMount
        onAutoEditConsumed={onAutoEditConsumed}
      />,
    );
    expect(screen.getByLabelText(/Rename task/)).toBeInTheDocument();
    expect(onAutoEditConsumed).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Build-mode-only surfaces: ⋮⋮ pointer reorder (#347) and milestone start-cell
// date popover (#345). These require a BuildModeProvider ancestor.
// ───────────────────────────────────────────────────────────────────────────
function BuildHarness({
  task = base,
  level = 2,
  siblingIds,
  milestoneParents,
  capture,
}: {
  task?: Task;
  level?: number;
  siblingIds?: string[];
  milestoneParents?: { name: string; finish?: string }[];
  capture?: { current: { focusRow: (id: string) => void } | null };
}) {
  const focus = useScheduleFocus();
  const api = useMemo<BuildModeApi>(
    () => ({
      focus,
      indent: vi.fn(),
      outdent: vi.fn(),
      insertBelow: vi.fn(),
      convertToMilestone: vi.fn(),
      deleteTask: vi.fn(),
      isMutationPending: () => false,
    }),
    [focus],
  );
  if (capture) capture.current = { focusRow: focus.focusRow };
  return (
    <BuildModeProvider api={api}>
      <TaskListRow
        task={task}
        level={level}
        widths={widths}
        visible={visible}
        siblingIds={siblingIds}
        milestoneParents={milestoneParents}
      />
    </BuildModeProvider>
  );
}

function renderBuild(props: Parameters<typeof BuildHarness>[0] = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/projects/p1/schedule']}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/projects/:projectId/schedule" element={<BuildHarness {...props} />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('TaskListRow — ⋮⋮ pointer-drag reorder (#347)', () => {
  beforeAll(() => {
    // jsdom lacks pointer-capture; the drag handle calls setPointerCapture.
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
  });

  it('reorders the row by the rounded number of rows dragged', () => {
    renderBuild({ siblingIds: ['t1', 't2', 't3'] });
    const handle = screen.getByTitle(/Drag to reorder/);
    fireEvent.pointerDown(handle, { clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 40, pointerId: 1 });
    // 60px ≈ 2 rows at ROW_HEIGHT 28 → move t1 down two slots.
    fireEvent.pointerUp(handle, { clientY: 60, pointerId: 1 });
    expect(mocks.reorderMutate).toHaveBeenCalledWith({
      parent_path: '1',
      ordered_ids: ['t2', 't3', 't1'],
    });
  });

  it('is a no-op when the drag stays within the same row slot', () => {
    renderBuild({ siblingIds: ['t1', 't2', 't3'] });
    const handle = screen.getByTitle(/Drag to reorder/);
    fireEvent.pointerDown(handle, { clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 12, pointerId: 1 });
    expect(mocks.reorderMutate).not.toHaveBeenCalled();
  });
});

describe('TaskListRow — milestone start-cell date popover (#345)', () => {
  const milestone: Task = { ...base, isMilestone: true, duration: 0, progress: 0 };

  it('toggles the date popover open on the start cell and commits a parent finish pick', async () => {
    const user = userEvent.setup();
    renderBuild({
      task: milestone,
      milestoneParents: [{ name: 'Design Phase', finish: '2026-10-20' }],
    });
    const startCell = screen.getByLabelText(/starts|unscheduled/);
    await user.click(startCell);
    expect(screen.getByRole('dialog', { name: 'Pick milestone date' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'End of Design Phase' }));
    expect(mocks.updateMutate).toHaveBeenCalledWith({
      id: 't1',
      projectId: 'p1',
      planned_start: '2026-10-20',
    });
  });

  it('opens the popover from the keyboard (Enter) on the milestone start cell', () => {
    renderBuild({ task: milestone, milestoneParents: [] });
    const startCell = screen.getByLabelText(/starts|unscheduled/);
    fireEvent.keyDown(startCell, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Pick milestone date' })).toBeInTheDocument();
  });
});
