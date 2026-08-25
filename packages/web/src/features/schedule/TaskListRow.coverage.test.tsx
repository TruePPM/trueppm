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
import { describe, expect, it, afterEach, beforeEach, beforeAll, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithRouter } from '@/test/utils';
import { useScheduleStore } from '@/stores/scheduleStore';
import { TaskListRow, splitWbsLeaf } from './TaskListRow';
import { BuildModeProvider } from './buildMode/BuildModeContext';
import { useScheduleFocus, type BuildModeApi } from './buildMode';
import type { Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import { stubCoarsePointer, restoreCoarsePointer } from '@/test/coarsePointer';

const mocks = vi.hoisted(() => ({
  toggleMutate: vi.fn(),
  duplicateMutate: vi.fn(),
  updateMutate: vi.fn(),
  updateMutateAsync: vi.fn(),
  reorderMutate: vi.fn(),
  warm: vi.fn(),
}));

// Member (100). Every case in this file exercises the row's AUTHORING
// apparatus, and since #2961 that apparatus is absent without edit rights (web
// rule 302). Without this the real hook resolves to "no role" mid-test, so a
// synchronous `fireEvent` case passes while its `await user.click` twin fails —
// which reads as a flake rather than as a missing fixture.
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: 100, roleLabel: null, isLoading: false }),
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
  wbs: 48, task: 180, links: 76, dur: 52, start: 74, finish: 74, progress: 52, owner: 72,
};
const visible: ColumnWidths['visible'] = {
  wbs: true, task: true, links: true, dur: true, start: true, finish: true, progress: true, owner: true,
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
    expect(screen.getByTestId('milestone-rollup-lock')).toBeInTheDocument();
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
    expect(screen.queryByTestId('milestone-rollup-lock')).toBeNull();
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
    const chip = screen.getByTestId('note-freshness-chip');
    expect(chip).toBeInTheDocument();
    // The marker is a house SVG, not the 📝 emoji it replaced.
    expect(chip.querySelector('svg')).toBeTruthy();
    expect(chip.textContent).toBe('');
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

  it('renders the flag UNSELECTED — the row carries its dependency state at rest', () => {
    // The shipped chips rendered only while the row was selected in focus mode,
    // so you had to select a row to learn whether it had links, which is the
    // opposite of scanning. Nothing selected here.
    useScheduleStore.setState({ selectedTaskId: null });
    renderWithRouter(
      <TaskListRow
        task={{ ...base, assignees: [{ resourceId: 'r1', name: 'Alice', units: 1 }] }}
        level={1}
        widths={widths}
        // Owner column hidden so the only AssigneeChips left is the name-column
        // one the dep chips used to displace — its "A" initial must be present.
        visible={{ ...visible, owner: false }}
        {...tree}
        depChips={{
          preds: [
            { type: 'FS', lag: 0 },
            { type: 'FS', lag: 0 },
          ],
          succs: [{ type: 'FS', lag: 0 }],
          predsCritical: true,
          succsCritical: false,
        }}
      />,
    );
    expect(screen.getByTestId('dep-flag-predecessor')).toHaveTextContent('←FS×2');
    expect(screen.getByTestId('dep-flag-predecessor').className).toMatch(/text-semantic-critical/);
    expect(screen.getByTestId('dep-flag-successor')).toHaveTextContent('→FS');
    // And it no longer displaces the assignee chip — they are different columns.
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('states the whole cell in one label, and puts the detail in the tooltip', () => {
    renderWithRouter(
      <TaskListRow
        task={base}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
        depChips={{
          preds: [
            { type: 'FS', lag: 0 },
            { type: 'SS', lag: 2 },
          ],
          succs: [],
          predsCritical: false,
          succsCritical: false,
        }}
      />,
    );
    const cell = screen.getByTestId('links-cell');
    expect(cell).toHaveAttribute(
      'aria-label',
      'Links for Design Phase — 2 predecessors: Finish-to-Start, Start-to-Start +2d',
    );
  });

  it('omits the predecessor flag when there are zero predecessors', () => {
    renderWithRouter(
      <TaskListRow
        task={base}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
        depChips={{
          preds: [],
          succs: [
            { type: 'FS', lag: 0 },
            { type: 'FS', lag: 0 },
          ],
          predsCritical: false,
          succsCritical: true,
        }}
      />,
    );
    expect(screen.queryByTestId('dep-flag-predecessor')).toBeNull();
    expect(screen.getByTestId('dep-flag-successor')).toHaveTextContent('→FS×2');
  });

  it('draws NO links cell when the surface has hidden the column', () => {
    // The Timeline narrows `visible.links` to false. Without the guard the row
    // would carry a gridcell the header does not, and the outline would be one
    // column out of alignment with every column-header count still passing.
    renderWithRouter(
      <TaskListRow
        task={base}
        level={1}
        widths={widths}
        visible={{ ...visible, links: false }}
        {...tree}
        depChips={{
          preds: [{ type: 'FS', lag: 0 }],
          succs: [],
          predsCritical: false,
          succsCritical: false,
        }}
      />,
    );
    expect(screen.queryByTestId('links-cell')).toBeNull();
    expect(screen.queryByTestId('dep-flag-predecessor')).toBeNull();
  });

  it('puts the per-row detail in the chip tooltip — the control\'s NAME is constant', () => {
    // The button is named "Edit predecessor links" on every row, so `title` is
    // the only per-row detail a sighted mouse user gets.
    renderWithRouter(
      <TaskListRow
        task={base}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
        depChips={{
          preds: [
            { type: 'FS', lag: 0 },
            { type: 'SS', lag: 2 },
          ],
          succs: [],
          predsCritical: true,
          succsCritical: false,
        }}
      />,
    );
    const chip = screen.getByTestId('dep-flag-predecessor');
    // The chip is nested inside the control when authoring is off, so walk up
    // to whichever element carries the tooltip.
    const titled = chip.closest('[title]');
    expect(titled).toHaveAttribute(
      'title',
      '2 predecessors: Finish-to-Start, Start-to-Start +2d — on the critical path',
    );
  });

  it('renders an em dash and the empty statement when the row has no links at all', () => {
    renderWithRouter(
      <TaskListRow task={base} level={1} widths={widths} visible={visible} {...tree} />,
    );
    expect(screen.queryByTestId('dep-flag-predecessor')).toBeNull();
    expect(screen.queryByTestId('dep-flag-successor')).toBeNull();
    expect(screen.getByTestId('links-cell')).toHaveAttribute(
      'aria-label',
      'Links: none for Design Phase',
    );
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

  it('dims out-of-chain rows in focus mode but keeps them interactive (#2782)', () => {
    renderWithRouter(
      <TaskListRow task={base} level={1} widths={widths} visible={visible} {...tree} dimmed />,
    );
    const row = screen.getByRole('row');
    expect(row.className).toContain('opacity-[0.22]');
    // The dim is de-emphasis, not disablement. `pointer-events-none` here made
    // the chain unrecoverable for a pointer user: an inert row never fires the
    // `mouseenter`/`mouseleave` that re-origins or clears the chain.
    expect(row.className).not.toContain('pointer-events-none');
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

  it('does not fire the hover bus when focus lands on a row that is in inline edit (#2782)', () => {
    const onHoverChange = vi.fn();
    renderWithRouter(
      <TaskListRow
        task={base}
        level={1}
        widths={widths}
        visible={visible}
        {...tree}
        startInlineEditOnMount
        onHoverChange={onHoverChange}
      />,
    );
    // Build mode creates a row and focuses its name cell programmatically. If
    // that focus fed the hover chain, `HOVER_SETTLE_MS` (80ms) later every other
    // row would dim on a chain of {the new row} — with the pointer nowhere near
    // the list, no `mouseleave` ever arrives to clear it.
    fireEvent.focus(screen.getByRole('row'));
    expect(onHoverChange).not.toHaveBeenCalled();
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
    expect(screen.getByLabelText(/Rename item/)).toBeInTheDocument();
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
      insertAbove: vi.fn(),
      insertChild: vi.fn(),
      mergeIntoPreviousRow: vi.fn(),
      isCaretAtEndRow: () => false,
      clearCaretAtEndRow: vi.fn(),
      convertToMilestone: vi.fn(),
      duplicateSubtree: vi.fn(),
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

describe('TaskListRow — the ⋮⋮ grip names the keyboard twins (#347, #2954)', () => {
  // Also puts the module row-height binding back on 28 — it is real global
  // state within this file, and a leaked 44 would silently change every later
  // row render here.
  afterEach(restoreCoarsePointer);

  beforeAll(() => {
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
  });

  it('advertises both what it does and how to do it without a pointer', () => {
    // The grip is aria-hidden on purpose — a tab stop per row would cost a
    // 40-row outline forty of them — so the title is the only place the
    // equivalence is stated to a pointer user who cannot drag comfortably.
    renderBuild({ siblingIds: ['t1', 't2', 't3'] });
    const title = screen.getByTestId('row-reorder-grip').getAttribute('title') ?? '';
    expect(title).toMatch(/reorder or reparent/i);
    expect(title).toMatch(/↑\/↓/);
    expect(title).toMatch(/←\/→/);
  });

  it('is aria-hidden — the gesture it starts is announced, the grip is not', () => {
    renderBuild({ siblingIds: ['t1', 't2', 't3'] });
    expect(screen.getByTestId('row-reorder-grip')).toHaveAttribute('aria-hidden', 'true');
  });

  it('does not commit anything by itself', () => {
    renderBuild({ siblingIds: ['t1', 't2', 't3'] });
    const handle = screen.getByTestId('row-reorder-grip');
    fireEvent.pointerDown(handle, { clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 60, pointerId: 1 });
    expect(mocks.reorderMutate).not.toHaveBeenCalled();
  });

  /**
   * #2997 — the grip's size follows the POINTER CLASS, not the viewport.
   *
   * jsdom has no layout, so these assert the inline style the browser will lay
   * out from; `e2e/schedule-coarse-row-height.spec.ts` is what proves the
   * resulting box actually measures 44x44. What this pair catches cheaply is the
   * regression that matters most: somebody reintroducing a literal, or
   * re-keying the size on a `md:` breakpoint (which is how a 1024px tablet ended
   * up with the 14px mouse grip in the first place).
   */
  it('is 44x44 on a coarse pointer', () => {
    stubCoarsePointer(true);
    renderBuild({ siblingIds: ['t1', 't2', 't3'] });
    const handle = screen.getByTestId('row-reorder-grip');
    expect(handle.style.width).toBe('44px');
    expect(handle.style.height).toBe('44px');
    // No breakpoint-keyed width may survive alongside the pointer-keyed one —
    // two sources for one size is the class this whole change exists to remove.
    expect(handle.className).not.toMatch(/w-\[26px\]|md:w-/);
  });

  it('stays narrow on a fine pointer — a mouse gives up no row width', () => {
    stubCoarsePointer(false);
    renderBuild({ siblingIds: ['t1', 't2', 't3'] });
    const handle = screen.getByTestId('row-reorder-grip');
    expect(handle.style.width).toBe('14px');
    expect(handle.style.height).toBe('28px');
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

// ───────────────────────────────────────────────────────────────────────────
// The WBS ladder (#3055). The column was right-aligned, which flushed every
// path to a common right edge and made `2.1` read as a peer of `3`. In a mono
// font the ladder is already in the string — left-alignment is what lets it
// show.
// ───────────────────────────────────────────────────────────────────────────
describe('splitWbsLeaf (#3055)', () => {
  it('splits a nested path into ancestors and leaf, keeping the dot on the prefix', () => {
    // The dot rides with the ancestors so the leaf span holds ONLY this row's
    // own number — that is what the weight is emphasising.
    expect(splitWbsLeaf('2.1')).toEqual({ ancestors: '2.', leaf: '1' });
    expect(splitWbsLeaf('1.10.5')).toEqual({ ancestors: '1.10.', leaf: '5' });
  });

  it('gives a depth-1 path no ancestors', () => {
    expect(splitWbsLeaf('3')).toEqual({ ancestors: '', leaf: '3' });
    expect(splitWbsLeaf('12')).toEqual({ ancestors: '', leaf: '12' });
  });

  it('splits on the LAST dot of an already-truncated path', () => {
    // Operates on the rendered string, not the raw path: `truncateWbsPath`
    // guarantees the leaf survives the middle ellipsis, so the visible leaf is
    // the one worth emphasising.
    expect(splitWbsLeaf('1.…2')).toEqual({ ancestors: '1.…', leaf: '2' });
  });

  it('yields an empty leaf when truncation left no visible own-number', () => {
    // `truncateWbsPath`'s two-segment branch puts the ellipsis LAST. There is
    // no own-number to emphasise, so the leaf span renders nothing.
    expect(splitWbsLeaf('10.…')).toEqual({ ancestors: '10.…', leaf: '' });
  });

  it('concatenates back to the input for every shape', () => {
    for (const path of ['1', '2.1', '1.10.5.2', '1.…2', '10.…', '10']) {
      const { ancestors, leaf } = splitWbsLeaf(path);
      expect(ancestors + leaf).toBe(path);
    }
  });
});

describe('TaskListRow — the WBS column reads as a ladder (#3055)', () => {
  const wbsCell = () => screen.getByRole('gridcell', { name: 'WBS 1.1' });

  it('left-aligns the column so leading segments line up with the parent row', () => {
    // THE defect. `justify-end` / `text-right` aligned on the LAST character,
    // which is a numeric convention applied to an identifier.
    renderRouted(<TaskListRow task={base} level={2} widths={widths} visible={visible} />);
    const cell = wbsCell();
    expect(cell.className).toContain('justify-start');
    expect(cell.className).toContain('text-left');
    expect(cell.className).not.toContain('justify-end');
    expect(cell.className).not.toContain('text-right');
  });

  it('does NOT add a per-level padding ladder on top of the string', () => {
    // The mono string already self-indents two characters per level. A padding
    // ladder compounds it and pushes the leaf into the ellipsis at depth 4+.
    const { container } = renderRouted(
      <TaskListRow task={{ ...base, wbs: '1.1.1.1' }} level={4} widths={widths} visible={visible} />,
    );
    const cell = container.querySelector('[aria-label="WBS 1.1.1.1"]') as HTMLElement;
    expect(cell.style.paddingLeft).toBe('');
  });

  it('emphasises the LEAF rather than fading the ancestors', () => {
    // Accessibility, not preference: there is no tertiary text token, and the
    // only weaker one would fail WCAG 1.4.3 for a low-vision sighted reader.
    renderRouted(<TaskListRow task={base} level={2} widths={widths} visible={visible} />);
    const leaf = wbsCell().querySelector('.text-neutral-text-primary') as HTMLElement;
    expect(leaf).not.toBeNull();
    expect(leaf.textContent).toBe('1');
    expect(leaf.className).toContain('font-medium');
    // The ancestors keep the cell's own secondary color — never disabled.
    expect(wbsCell().className).toContain('text-neutral-text-secondary');
    expect(wbsCell().className).not.toContain('text-neutral-text-disabled');
  });

  it('keeps the full untruncated path as the accessible name and the title', () => {
    // ~20 e2e specs locate rows by `WBS <path>`; the split must not fragment it.
    const { container } = renderRouted(
      <TaskListRow task={{ ...base, wbs: '1.10.5.2' }} level={4} widths={{ ...widths, wbs: 32 }} visible={visible} />,
    );
    const cell = container.querySelector('[aria-label="WBS 1.10.5.2"]') as HTMLElement;
    expect(cell).not.toBeNull();
    expect(cell.getAttribute('title')).toBe('1.10.5.2');
    // Visibly truncated, but the leaf survives — that is what the middle
    // ellipsis is for.
    expect(cell.textContent).not.toBe('1.10.5.2');
    expect(cell.textContent?.endsWith('2')).toBe(true);
  });

  it('renders the visible path as one contiguous string across the two spans', () => {
    renderRouted(<TaskListRow task={base} level={2} widths={widths} visible={visible} />);
    expect(wbsCell().textContent).toBe('1.1');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Containment chrome on a real row (#2956). The unit tests in
// RowContainmentChrome.test.tsx pin the geometry; these pin the wiring — which
// rows get a band, and that the marks reach the DOM at all.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — phase bands and depth guides (#2956)', () => {
  it('bands a phase row and gives it the edge at its indent origin', () => {
    renderRouted(
      <TaskListRow
        task={{ ...base, isPhase: true }}
        level={2}
        widths={widths}
        visible={visible}
        hasChildren
        childCount={3}
      />,
    );
    expect(screen.getByTestId('phase-band-edge')).toBeInTheDocument();
  });

  it('does NOT band a leaf that only has drawer subtasks', () => {
    // `isSummary` is true for any task with a child, including a leaf whose only
    // children are drawer subtasks (ADR-0060). Banding those would say
    // "container" about a row that contains no structural work — which is the
    // exact confusion this issue exists to remove.
    renderRouted(
      <TaskListRow
        task={{ ...base, isSummary: true, isPhase: false }}
        level={2}
        widths={widths}
        visible={visible}
        hasChildren
        childCount={2}
      />,
    );
    expect(screen.queryByTestId('phase-band-edge')).not.toBeInTheDocument();
  });

  // ── Declared containers (#3056) ──────────────────────────────────────────
  //
  // `structure_role` is DECLARED by the author (#2950) and is documented — in
  // its own help_text and on the `Task` type — as governing rendering. The row
  // did not read it, so a container whose last child was moved out lost its
  // band and rendered as ordinary work while the server still called it a
  // container. These pin the declaration as the FIRST signal.

  it('bands a DECLARED container that has no children yet', () => {
    // THE defect. `isPhase` is the server's derived EXISTS(structural child)
    // verdict, so it is correctly false here — the row has nothing in it. The
    // declaration is what says "this is a lane", and models.py is explicit that
    // a declared container which loses its last child stays declared.
    renderRouted(
      <TaskListRow
        task={{ ...base, isPhase: false, isSummary: false, structureRole: 'container' }}
        level={2}
        widths={widths}
        visible={visible}
      />,
    );
    expect(screen.getByTestId('phase-band-edge')).toBeInTheDocument();
  });

  it('gives an empty declared container NO fold caret', () => {
    // Falls out of `hasChildren` being computed independently rather than being
    // special-cased: there is nothing to fold, and a caret that cannot expand is
    // a broken affordance. The row reads as "a container, currently empty".
    renderRouted(
      <TaskListRow
        task={{ ...base, isPhase: false, isSummary: false, structureRole: 'container' }}
        level={2}
        widths={widths}
        visible={visible}
      />,
    );
    expect(screen.queryByRole('button', { name: /inside|hidden/i })).not.toBeInTheDocument();
  });

  it('does NOT band a declared `work` row that has no children', () => {
    renderRouted(
      <TaskListRow
        task={{ ...base, isPhase: false, isSummary: false, structureRole: 'work' }}
        level={2}
        widths={widths}
        visible={visible}
      />,
    );
    expect(screen.queryByTestId('phase-band-edge')).not.toBeInTheDocument();
  });

  it('never bands a subtask, even one that somehow declares container', () => {
    // A drawer leaf is never structure. The subtask test runs before the
    // declaration for exactly this reason.
    renderRouted(
      <TaskListRow
        task={{ ...base, isSubtask: true, isPhase: false, structureRole: 'container' }}
        level={2}
        widths={widths}
        visible={visible}
      />,
    );
    expect(screen.queryByTestId('phase-band-edge')).not.toBeInTheDocument();
  });

  it('falls back to the structural-child test when the server omits isPhase', () => {
    // A deployment that has not shipped #1753 sends no `isPhase`; the row must
    // still band rather than silently losing the whole signal.
    renderRouted(
      <TaskListRow
        task={base}
        level={2}
        widths={widths}
        visible={visible}
        hasChildren
        childCount={2}
      />,
    );
    expect(screen.getByTestId('phase-band-edge')).toBeInTheDocument();
  });

  it('gives a nested row one depth guide per ancestor level', () => {
    const { container } = renderRouted(
      <TaskListRow task={base} level={3} widths={widths} visible={visible} />,
    );
    expect(container.querySelectorAll('[data-depth]')).toHaveLength(2);
  });

  it('gives a root row no guides', () => {
    const { container } = renderRouted(
      <TaskListRow task={base} level={1} widths={widths} visible={visible} />,
    );
    expect(container.querySelectorAll('[data-depth]')).toHaveLength(0);
  });

  it('leaves the row clickable under the chrome (the #2782 class)', () => {
    renderRouted(
      <TaskListRow
        task={{ ...base, isPhase: true }}
        level={3}
        widths={widths}
        visible={visible}
        hasChildren
        childCount={1}
      />,
    );
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: ' ' });
    expect(mocks.toggleMutate).toHaveBeenCalledTimes(1);
  });
});
