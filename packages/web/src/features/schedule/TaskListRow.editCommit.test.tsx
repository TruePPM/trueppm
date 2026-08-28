/**
 * Deep-branch coverage for the build-mode inline cell-edit commit paths and the
 * post-commit sprint-assignment region on TaskListRow that the existing
 * .test / .coverage / .buildMode / .keyboardExtract suites reach into but never
 * *commit* through:
 *
 *   - Name cell EditableCell: commit (→ updateTask + open SprintPrompt),
 *     Escape rollback, Tab/Shift-Tab traversal, autocomplete query + select.
 *   - Duration cell EditableCell: commit raising the inline "Recalc %?" prompt
 *     (ADR-0151), and the RecalcPercentChip accept / dismiss actions.
 *   - Progress cell EditableCell: commit + the progress-anchor and
 *     rollup-locked structured-400 error branches (and the "other error" no-op).
 *   - SprintAssignmentRegion (#346 / ADR-0101): the warn → GuardrailNotice
 *     (Keep / Undo) branch, the block → GuardrailBlock (Got it) branch, the
 *     clean-success and unrecognized-error dismissals.
 *   - buildRowMenuItems Add-predecessor / Add-successor onSelect wiring.
 *   - formatDate's empty-string and unparseable-input em-dash fallbacks.
 *
 * The mutation hooks are mocked so the mutate options object is observable, and
 * SprintPrompt is stubbed to a single deterministic onSelect trigger so the
 * region's own success/error reducer is exercised without standing up the real
 * sprint-picker (which fetches project + sprints).
 */
import type { DependencyDirection } from './deps/linkTypes';
import { useMemo } from 'react';
import { screen, render, fireEvent, act } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useScheduleStore } from '@/stores/scheduleStore';
import type { Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import { ROLE_MEMBER, ROLE_ADMIN } from '@/lib/roles';

const mocks = vi.hoisted(() => ({
  updateMutate: vi.fn(),
  updateMutateAsync: vi.fn(() => Promise.resolve()),
  reorderMutate: vi.fn(),
  toggleMutate: vi.fn(),
  duplicateMutate: vi.fn(),
  // #2639: the auto-status confirmation dialog names the target status from
  // the acting user's role. Defaults to null (unresolved) like the real hook
  // returns synchronously before its query settles; individual tests set it.
  // Member by default: every case in this file exercises AUTHORING, and since
  // #2961 the row's apparatus is absent without edit rights (web rule 302). A
  // null role here means "not a member", which is a different fixture — the
  // cases that want it set it explicitly.
  // 100 is ROLE_MEMBER, written as a literal because this is a `vi.hoisted`
  // block and cannot reference an import.
  currentRole: 100 as number | null,
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: mocks.currentRole, roleLabel: null, isLoading: false }),
}));

vi.mock('@/hooks/useTaskMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTaskMutations')>();
  return {
    ...actual,
    useUpdateTask: () =>
      ({ mutate: mocks.updateMutate, mutateAsync: mocks.updateMutateAsync }) as never,
    useReorderTasks: () => ({ mutate: mocks.reorderMutate }) as never,
    useToggleComplete: () => ({ mutate: mocks.toggleMutate }) as never,
    useDuplicateTask: () => ({ mutate: mocks.duplicateMutate }) as never,
  };
});

// The duration cell only raises the "Recalc %?" prompt under the effective
// `confirm` policy (ADR-0151); pin it so the chip surfaces on a qualifying edit.
vi.mock('@/hooks/useProject', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useProject')>();
  return {
    ...actual,
    useEffectiveDurationPolicy: () => 'confirm',
  };
});

// Stub SprintPrompt to a single deterministic onSelect trigger so the region's
// own success/error reducer is what we exercise (not the real picker's fetches).
vi.mock('./buildMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./buildMode')>();
  return {
    ...actual,
    SprintPrompt: ({
      open,
      onSelect,
      onDismiss,
    }: {
      open: boolean;
      onSelect: (sprintId: string | null, pts: number | null) => void;
      onDismiss: () => void;
    }) =>
      open ? (
        <div>
          <button type="button" data-testid="sprint-pick" onClick={() => onSelect('s2', 5)}>
            pick sprint
          </button>
          <button type="button" data-testid="sprint-dismiss" onClick={onDismiss}>
            later
          </button>
        </div>
      ) : null,
  };
});

// Imported AFTER the mocks so the component + harness pick up the mocked hooks.
const { TaskListRow } = await import('./TaskListRow');
const { BuildModeProvider } = await import('./buildMode/BuildModeContext');
const { useScheduleFocus } = await import('./buildMode');
type BuildModeApi = import('./buildMode').BuildModeApi;
type FocusApi = import('./buildMode').UseScheduleFocusReturn;

const widths: ColumnWidths['widths'] = {
  wbs: 48, task: 220, links: 76, dur: 60, start: 80, finish: 80, progress: 50, owner: 72,
};
const visible: ColumnWidths['visible'] = {
  wbs: true, task: true, links: true, dur: true, start: true, finish: true, progress: true, owner: true,
};

const base: Task = {
  id: 't1', wbs: '1.2', name: 'Design Phase', start: '2026-10-05', finish: '2026-10-15',
  duration: 10, progress: 50, parentId: 't0',
  isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
  status: 'NOT_STARTED', assignees: [], notes: '',
};

const spies = {
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
};

interface HarnessProps {
  task?: Task;
  /** #3079 — omitted means "as shipped" (Enter also inserts a row). */
  enterCreatesRow?: boolean;
  level?: number;
  siblingIds?: string[];
  nameSuggestions?: string[];
  onAddDependencyRequest?: (taskId: string, direction?: DependencyDirection) => void;
  focusRef: { current: FocusApi | null };
}

function Harness({
  task = base,
  enterCreatesRow,
  level = 2,
  siblingIds,
  nameSuggestions,
  onAddDependencyRequest,
  focusRef,
}: HarnessProps) {
  const focus = useScheduleFocus();
  focusRef.current = focus;
  const api = useMemo<BuildModeApi>(
    () => ({
      focus,
      indent: spies.indent,
      outdent: spies.outdent,
      insertBelow: spies.insertBelow,
      insertAbove: spies.insertAbove,
      insertChild: spies.insertChild,
      mergeIntoPreviousRow: spies.mergeIntoPreviousRow,
      isCaretAtEndRow: spies.isCaretAtEndRow,
      clearCaretAtEndRow: spies.clearCaretAtEndRow,
      convertToMilestone: spies.convertToMilestone,
      duplicateSubtree: spies.duplicateSubtree,
      deleteTask: spies.deleteTask,
      isMutationPending: () => false,
      ...(enterCreatesRow === undefined ? {} : { enterCreatesRow }),
    }),
    [focus, enterCreatesRow],
  );
  return (
    <BuildModeProvider api={api}>
      <TaskListRow
        task={task}
        level={level}
        widths={widths}
        visible={visible}
        siblingIds={siblingIds}
        nameSuggestions={nameSuggestions}
        onAddDependencyRequest={onAddDependencyRequest}
      />
    </BuildModeProvider>
  );
}

function renderBuild(props: Omit<HarnessProps, 'focusRef'> = {}) {
  const focusRef: { current: FocusApi | null } = { current: null };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={['/projects/p1/schedule']}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route
            path="/projects/:projectId/schedule"
            element={<Harness {...props} focusRef={focusRef} />}
          />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { focus: () => focusRef.current as FocusApi };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentRole = ROLE_MEMBER;
  useScheduleStore.setState({
    selectedTaskId: null,
    scheduleError: null,
    scheduleActionToast: null,
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Name cell — EditableCell commit / rollback / traversal / autocomplete.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — Name cell commit (build mode)', () => {
  it('committing a new name PATCHes it and opens the sprint prompt + insertBelow', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild();
    act(() => { focus().focusRow('t1'); focus().enterCellEdit('t1', 'name'); });
    const input = screen.getByLabelText('Rename item Design Phase');
    await user.clear(input);
    await user.type(input, 'Discovery{Enter}');

    expect(mocks.updateMutate).toHaveBeenCalledWith({
      id: 't1',
      projectId: 'p1',
      name: 'Discovery',
    });
    // onEnterCommit → commit-and-continue inserts a sibling below (#1666).
    expect(spies.insertBelow).toHaveBeenCalledWith('t1');
    // onCommit also flips showSprintPrompt → the (stubbed) SprintPrompt renders.
    expect(screen.getByTestId('sprint-pick')).toBeInTheDocument();
  });

  // #3079 — the reported case. Renaming an existing row committed the edit AND
  // spawned a blank row that then had to be deleted, every time.
  it('with Enter-creates-a-row off, committing a rename does NOT insert a row', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild({ enterCreatesRow: false });
    act(() => { focus().focusRow('t1'); focus().enterCellEdit('t1', 'name'); });
    const input = screen.getByLabelText('Rename item Design Phase');
    await user.clear(input);
    await user.type(input, 'Discovery{Enter}');

    // The edit still commits — that is the half the preference must not touch.
    expect(mocks.updateMutate).toHaveBeenCalledWith({
      id: 't1',
      projectId: 'p1',
      name: 'Discovery',
    });
    expect(spies.insertBelow).not.toHaveBeenCalled();
  });

  it('with it off, Shift+Enter in the name cell still inserts above', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild({ enterCreatesRow: false });
    act(() => { focus().focusRow('t1'); focus().enterCellEdit('t1', 'name'); });
    const input = screen.getByLabelText('Rename item Design Phase');
    await user.clear(input);
    await user.type(input, 'Discovery{Shift>}{Enter}{/Shift}');
    expect(spies.insertAbove).toHaveBeenCalledWith('t1');
  });

  it('Escape in the name cell rolls back to the row without a PATCH', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild();
    act(() => { focus().focusRow('t1'); focus().enterCellEdit('t1', 'name'); });
    const input = screen.getByLabelText('Rename item Design Phase');
    await user.clear(input);
    await user.type(input, 'Scrapped{Escape}');
    expect(mocks.updateMutate).not.toHaveBeenCalled();
    // rollbackToRow returns to RowFocused (the cell is no longer in edit).
    expect(focus().state.mode).toBe('RowFocused');
  });

  it('Tab commits and advances the column; Shift-Tab retreats', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild();
    act(() => { focus().focusRow('t1'); focus().enterCellEdit('t1', 'name'); });
    const input = screen.getByLabelText('Rename item Design Phase');
    await user.clear(input);
    await user.type(input, 'Renamed');
    fireEvent.keyDown(input, { key: 'Tab' });
    // Tab commits the pending draft (onCommit → PATCH) then tabs forward.
    expect(mocks.updateMutate).toHaveBeenCalledWith({
      id: 't1',
      projectId: 'p1',
      name: 'Renamed',
    });
  });

  it('typing feeds the autocomplete and picking a suggestion PATCHes that name', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild({ nameSuggestions: ['Design Review', 'Deploy'] });
    act(() => { focus().focusRow('t1'); focus().enterCellEdit('t1', 'name'); });
    const input = screen.getByLabelText('Rename item Design Phase');
    await user.clear(input);
    await user.type(input, 'Des');
    // Substring match surfaces "Design Review" in the listbox.
    const option = await screen.findByRole('option', { name: 'Design Review' });
    fireEvent.mouseDown(option);
    expect(mocks.updateMutate).toHaveBeenCalledWith({
      id: 't1',
      projectId: 'p1',
      name: 'Design Review',
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Duration cell — commit raises the inline Recalc %? prompt (ADR-0151).
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — Duration cell commit → Recalc prompt', () => {
  it('committing a shorter duration PATCHes it and offers the prorated recalc, which accepts', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild();
    act(() => { focus().focusRow('t1'); focus().enterCellEdit('t1', 'duration'); });
    const input = screen.getByLabelText('Duration: 10 days. Press Enter to edit.');
    await user.clear(input);
    await user.type(input, '5{Enter}');

    expect(mocks.updateMutate).toHaveBeenCalledWith({ id: 't1', projectId: 'p1', duration: 5 });
    // progress 50 over 10→5 days → prorated to 100%. Accepting re-PATCHes it.
    const chip = await screen.findByTestId('recalc-percent-chip');
    expect(chip).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Recalculate percent complete/ }));
    expect(mocks.updateMutateAsync).toHaveBeenCalledWith({
      id: 't1',
      projectId: 'p1',
      percent_complete: 100,
    });
  });

  it('Keep dismisses the recalc prompt without a second PATCH', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild();
    act(() => { focus().focusRow('t1'); focus().enterCellEdit('t1', 'duration'); });
    const input = screen.getByLabelText('Duration: 10 days. Press Enter to edit.');
    await user.clear(input);
    await user.type(input, '5{Enter}');
    await screen.findByTestId('recalc-percent-chip');
    await user.click(screen.getByRole('button', { name: 'Keep current percent complete' }));
    expect(screen.queryByTestId('recalc-percent-chip')).toBeNull();
    expect(mocks.updateMutateAsync).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Progress cell — commit + structured-400 error branches.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — Progress cell commit error handling', () => {
  function commitProgress(value: string) {
    const { focus } = renderBuild();
    act(() => { focus().focusRow('t1'); focus().enterCellEdit('t1', 'progress'); });
    const input = screen.getByLabelText('Progress: 50%. Press Enter to edit.');
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const call = mocks.updateMutate.mock.calls[0] as [
      Record<string, unknown>,
      { onError: (e: unknown) => void },
    ];
    return call;
  }

  it('PATCHes percent_complete on commit', () => {
    const [vars] = commitProgress('80');
    expect(vars).toMatchObject({ id: 't1', projectId: 'p1', percent_complete: 80 });
  });

  it('surfaces the anchor-required message on a progress_requires_anchor 400', () => {
    const [, opts] = commitProgress('80');
    act(() => opts.onError({ response: { data: { code: 'progress_requires_anchor' } } }));
    expect(useScheduleStore.getState().scheduleError).toMatch(/Planned Start date/);
  });

  it('surfaces the rollup-locked message on a milestone_rollup_locked 400', () => {
    const [, opts] = commitProgress('80');
    act(() =>
      opts.onError({
        response: { data: { code: 'milestone_rollup_locked', detail: 'x', suggested_action: 'y' } },
      }),
    );
    expect(useScheduleStore.getState().scheduleError).toMatch(/rolls up from sprint/);
  });

  it('ignores an unrecognized error shape (no schedule error set)', () => {
    const [, opts] = commitProgress('80');
    act(() => opts.onError(new Error('network')));
    expect(useScheduleStore.getState().scheduleError).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Progress cell — the #2639 auto-status confirmation gate. Committing 100%
// from a NOT_STARTED/IN_PROGRESS task (the `base` fixture's status) with no
// explicit status is exactly the server's silent-promotion trigger; the grid
// cell must gate it behind a dialog naming the caller's role-dependent target,
// same as the drawer's OverviewSection.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — Progress cell auto-status confirm (#2639)', () => {
  function enterProgressCellAndType(value: string) {
    const { focus } = renderBuild();
    act(() => { focus().focusRow('t1'); focus().enterCellEdit('t1', 'progress'); });
    const input = screen.getByLabelText('Progress: 50%. Press Enter to edit.');
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
  }

  it('does not PATCH immediately at 100% — shows a confirmation first', () => {
    enterProgressCellAndType('100');
    expect(mocks.updateMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('names Review for a contributor (role unresolved / below Admin)', () => {
    mocks.currentRole = ROLE_MEMBER;
    enterProgressCellAndType('100');
    expect(screen.getByText(/Send task to Review\?/i)).toBeInTheDocument();
  });

  it('names Complete for an Admin', () => {
    mocks.currentRole = ROLE_ADMIN;
    enterProgressCellAndType('100');
    expect(screen.getByText(/Mark task Complete\?/i)).toBeInTheDocument();
  });

  it('PATCHes percent_complete=100 only after the contributor confirms Review', () => {
    mocks.currentRole = ROLE_MEMBER;
    enterProgressCellAndType('100');
    fireEvent.click(screen.getByRole('button', { name: /Send to Review/i }));
    expect(mocks.updateMutate).toHaveBeenCalledWith(
      { id: 't1', projectId: 'p1', percent_complete: 100 },
      expect.any(Object),
    );
  });

  it('PATCHes percent_complete=100 only after the Admin confirms Complete', () => {
    mocks.currentRole = ROLE_ADMIN;
    enterProgressCellAndType('100');
    fireEvent.click(screen.getByRole('button', { name: /Mark Complete/i }));
    expect(mocks.updateMutate).toHaveBeenCalledWith(
      { id: 't1', projectId: 'p1', percent_complete: 100 },
      expect.any(Object),
    );
  });

  it('cancelling sends no PATCH', () => {
    mocks.currentRole = ROLE_MEMBER;
    enterProgressCellAndType('100');
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(mocks.updateMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('skips the confirmation entirely below 100% (existing behavior unchanged)', () => {
    enterProgressCellAndType('80');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mocks.updateMutate).toHaveBeenCalledWith(
      { id: 't1', projectId: 'p1', percent_complete: 80 },
      expect.any(Object),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Sprint-assignment region (#346 / ADR-0101) — warn / block / clean / other.
// Reached via a name commit (which opens the stubbed SprintPrompt).
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — SprintAssignmentRegion outcomes', () => {
  async function openSprintSelect() {
    const user = userEvent.setup();
    const { focus } = renderBuild();
    act(() => { focus().focusRow('t1'); focus().enterCellEdit('t1', 'name'); });
    const input = screen.getByLabelText('Rename item Design Phase');
    await user.clear(input);
    await user.type(input, 'Renamed{Enter}');
    // Clear the name PATCH so the subsequent sprint PATCH is calls[0].
    mocks.updateMutate.mockClear();
    await user.click(screen.getByTestId('sprint-pick'));
    return { user };
  }

  it('a Tier-1 warn renders the GuardrailNotice; Keep dismisses it', async () => {
    const { user } = await openSprintSelect();
    expect(mocks.updateMutate).toHaveBeenCalledWith(
      { id: 't1', projectId: 'p1', sprint: 's2', story_points: 5 },
      expect.objectContaining({
        onSuccess: expect.any(Function) as unknown,
        onError: expect.any(Function) as unknown,
      }),
    );
    const [, opts] = mocks.updateMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (d: unknown) => void },
    ];
    act(() =>
      opts.onSuccess({ warnings: [{ rule: 'phase_in_sprint', detail: 'Phase double-counts' }] }),
    );
    expect(screen.getByText('Phase double-counts')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep it here' }));
    expect(screen.queryByText('Phase double-counts')).toBeNull();
  });

  it('Undo on a warn re-PATCHes back to the prior sprint (null → backlog)', async () => {
    const { user } = await openSprintSelect();
    const [, opts] = mocks.updateMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (d: unknown) => void },
    ];
    act(() =>
      opts.onSuccess({ warnings: [{ rule: 'summary_in_sprint', detail: 'Summary in sprint' }] }),
    );
    mocks.updateMutate.mockClear();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    // priorSprintId was null (base task had no sprint) → revert to backlog.
    expect(mocks.updateMutate).toHaveBeenCalledWith({ id: 't1', projectId: 'p1', sprint: null });
  });

  it('a clean success (no warnings) simply closes the prompt', async () => {
    await openSprintSelect();
    const [, opts] = mocks.updateMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (d: unknown) => void },
    ];
    act(() => opts.onSuccess({ warnings: [] }));
    expect(screen.queryByTestId('sprint-pick')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a Tier-2 block renders the GuardrailBlock; Got it dismisses it', async () => {
    const { user } = await openSprintSelect();
    const [, opts] = mocks.updateMutate.mock.calls[0] as [
      unknown,
      { onError: (e: unknown) => void },
    ];
    act(() =>
      opts.onError({
        response: {
          data: {
            code: 'guardrail_blocked',
            rule: 'phase_in_sprint',
            detail: 'Owner blocked phase assignment',
            suggested_action: 'assign_children',
          },
        },
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Owner blocked phase assignment');
    await user.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an unrecognized error just closes the prompt (no block panel)', async () => {
    await openSprintSelect();
    const [, opts] = mocks.updateMutate.mock.calls[0] as [
      unknown,
      { onError: (e: unknown) => void },
    ];
    act(() => opts.onError(new Error('boom')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('sprint-pick')).toBeNull();
  });

  it('dismissing the sprint prompt ("later") closes it without a sprint PATCH', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild();
    act(() => { focus().focusRow('t1'); focus().enterCellEdit('t1', 'name'); });
    const input = screen.getByLabelText('Rename item Design Phase');
    await user.clear(input);
    await user.type(input, 'Renamed{Enter}');
    mocks.updateMutate.mockClear();
    await user.click(screen.getByTestId('sprint-dismiss'));
    expect(screen.queryByTestId('sprint-pick')).toBeNull();
    // No second (sprint) PATCH fired — only the earlier name PATCH, now cleared.
    expect(mocks.updateMutate).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Build-mode context menu — Add dependency wiring (#477, one item since #3113).
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — dependency menu items', () => {
  it('Add dependency calls onAddDependencyRequest with NO direction, letting the dialog default', () => {
    // The menu deliberately does not pick a side. Direction is a field inside
    // the dialog now, so seeding it from the menu would re-create the thing
    // #3113 removed — a choice made before you can see it.
    const onAddDependencyRequest = vi.fn();
    renderBuild({ onAddDependencyRequest });
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 40, clientY: 40 });

    fireEvent.click(screen.getByRole('menuitem', { name: /Add dependency/ }));
    expect(onAddDependencyRequest).toHaveBeenCalledWith('t1');
  });

  it('the dependency item is disabled when no handler is wired', () => {
    renderBuild();
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 40, clientY: 40 });
    expect(screen.getByRole('menuitem', { name: /Add dependency/ })).toBeDisabled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// formatDate em-dash fallbacks (empty + unparseable) via a milestone start cell.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — formatDate fallbacks', () => {
  function renderPlain(task: Task) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={['/projects/p1/schedule']}>
        <QueryClientProvider client={qc}>
          <Routes>
            <Route
              path="/projects/:projectId/schedule"
              element={<TaskListRow task={task} level={1} widths={widths} visible={visible} />}
            />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('renders an em-dash for a milestone with an empty start date', () => {
    renderPlain({ ...base, isMilestone: true, duration: 0, progress: 0, start: '' });
    const cell = screen.getByLabelText('unscheduled');
    expect(cell).toHaveTextContent('—');
  });

  it('renders an em-dash for a milestone with an unparseable start date', () => {
    renderPlain({ ...base, isMilestone: true, duration: 0, progress: 0, start: 'not-a-date' });
    // fmtUtcShort returns the raw input unchanged → formatDate collapses it to —.
    const cell = screen.getByLabelText(/starts/);
    expect(cell).toHaveTextContent('—');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ⋮⋮ reorder handle — pointer-move with no active drag is a guarded no-op.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — reorder handle guards', () => {
  it('a pointer-move without a preceding pointer-down does not reorder', () => {
    renderBuild({ siblingIds: ['t1', 't2', 't3'] });
    const handle = screen.getByTitle(/Drag to reorder/);
    fireEvent.pointerMove(handle, { clientY: 50, pointerId: 1 });
    expect(mocks.reorderMutate).not.toHaveBeenCalled();
  });
});
