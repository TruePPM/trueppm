/**
 * Branch-coverage companion to the existing TaskListRow suites (#2459).
 *
 * TaskListRow.test / .buildMode / .coverage / .editCommit / .keyboardExtract all
 * drive the "yes" side of the row's conditionals. This file drives the "no"
 * side — the guards, fallbacks and alternate ternary arms they leave cold:
 *
 *   - `tryBuildModeReorder` when the row is missing from its own sibling list,
 *     and `tryBuildModeFocusMove`'s Alt-modifier bail-out.
 *   - Enter on an ALREADY-selected row (the deselect arm of the flag-off toggle).
 *   - `handleRowKeyDown`'s sprint-outcome containment guard (ADR-0101 §2).
 *   - The ⋮⋮ reorder handle's pointer-up guards (no prior pointer-down; the row
 *     absent from `siblingIds`).
 *   - The 4 s / 5 s auto-clear timers on every schedule-error toast the row
 *     raises, and `handleDuplicate`'s no-project-id bail.
 *   - `handleRowContextMenu` outside build mode (no menu, no preventDefault).
 *   - The plural / empty-sprint-name arms of the "N planned" badge (#1798) and
 *     the singular / non-critical arms of the dependency chips.
 *   - Escape-rollback and Tab / Shift-Tab traversal out of the Name, Duration
 *     and Progress cells.
 *   - Space (not just Enter) on a build-mode milestone Start cell.
 *   - The unscheduled arms of the Finish cell.
 *
 * Mirrors the mocking conventions of TaskListRow.editCommit.test.tsx: the
 * mutation hooks are mocked so the mutate options object is observable, and
 * SprintPrompt is stubbed to a deterministic trigger.
 */
import { useMemo, type ReactElement } from 'react';
import type React from 'react';
import { screen, render, fireEvent, act } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithRouter } from '@/test/utils';
import { useScheduleStore } from '@/stores/scheduleStore';
import type { Task } from '@/types';
import type { ColumnWidths } from '@/hooks/useColumnWidths';

const mocks = vi.hoisted(() => ({
  updateMutate: vi.fn(),
  updateMutateAsync: vi.fn(() => Promise.resolve()),
  reorderMutate: vi.fn(),
  toggleMutate: vi.fn(),
  duplicateMutate: vi.fn(),
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
    useUpdateTask: () =>
      ({ mutate: mocks.updateMutate, mutateAsync: mocks.updateMutateAsync }) as never,
    useReorderTasks: () => ({ mutate: mocks.reorderMutate }) as never,
    useToggleComplete: () => ({ mutate: mocks.toggleMutate }) as never,
    useDuplicateTask: () => ({ mutate: mocks.duplicateMutate }) as never,
  };
});

// Stub SprintPrompt to a deterministic onSelect trigger — the guardrail-outcome
// panel is a prerequisite for the key-containment guard exercised below, not the
// subject of this file.
vi.mock('./buildMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./buildMode')>();
  return {
    ...actual,
    SprintPrompt: ({
      open,
      onSelect,
    }: {
      open: boolean;
      onSelect: (sprintId: string | null, pts: number | null) => void;
    }) =>
      open ? (
        <button type="button" data-testid="sprint-pick" onClick={() => onSelect('s2', 5)}>
          pick sprint
        </button>
      ) : null,
  };
});

// Imported AFTER the mocks so the component picks up the mocked hooks.
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
  level?: number;
  siblingIds?: string[];
  nameSuggestions?: string[];
  prevTaskId?: string | null;
  nextTaskId?: string | null;
  milestoneParents?: { name: string; finish?: string }[];
  onOutlineDragStart?: (taskId: string, e: React.PointerEvent) => void;
  focusRef: { current: FocusApi | null };
}

function Harness({
  task = base,
  level = 2,
  siblingIds,
  nameSuggestions,
  prevTaskId,
  nextTaskId,
  milestoneParents,
  onOutlineDragStart,
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
    }),
    [focus],
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
        prevTaskId={prevTaskId}
        nextTaskId={nextTaskId}
        milestoneParents={milestoneParents}
        onOutlineDragStart={onOutlineDragStart}
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

/** Render a bare (flag-off) row under a real project route. */
function renderPlain(ui: ReactElement) {
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

beforeEach(() => {
  vi.clearAllMocks();
  useScheduleStore.setState({
    selectedTaskId: null,
    scheduleError: null,
    scheduleActionToast: null,
    revealGutterSprint: null,
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Build-mode keyboard reducer — the arms that decline to consume the event.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — Alt+Arrow reorder guards (#347)', () => {
  it('consumes Alt+Arrow without reordering when the row is absent from siblingIds', () => {
    const { focus } = renderBuild({ siblingIds: ['other-a', 'other-b'] });
    act(() => focus().focusRow('t1'));
    const row = screen.getByRole('row');

    fireEvent.keyDown(row, { key: 'ArrowDown', altKey: true });

    // Consumed (no fall-through to focus traversal or the letter-key cell entry),
    // but there is no slot to move the row into, so nothing is PATCHed.
    expect(mocks.reorderMutate).not.toHaveBeenCalled();
    expect(focus().state.rowId).toBe('t1');
  });

  it('is inert when the row is at the top of its sibling list and Alt+ArrowUp is pressed', () => {
    const { focus } = renderBuild({ siblingIds: ['t1', 't2'] });
    act(() => focus().focusRow('t1'));

    fireEvent.keyDown(screen.getByRole('row'), { key: 'ArrowUp', altKey: true });

    expect(mocks.reorderMutate).not.toHaveBeenCalled();
  });

  it('Alt+Arrow never falls through to row-focus traversal', () => {
    // No siblingIds → the reorder arm declines; the focus-move arm must then
    // decline too (Alt is a reorder modifier, never a navigation one), so the
    // focused row does NOT advance to nextTaskId.
    const { focus } = renderBuild({ nextTaskId: 't2', prevTaskId: 't0' });
    act(() => focus().focusRow('t1'));

    fireEvent.keyDown(screen.getByRole('row'), { key: 'ArrowDown', altKey: true });

    expect(focus().state.rowId).toBe('t1');
    expect(mocks.reorderMutate).not.toHaveBeenCalled();
  });

  it('plain ArrowDown (no Alt) DOES move row focus to the next row', () => {
    const { focus } = renderBuild({ nextTaskId: 't2' });
    act(() => focus().focusRow('t1'));

    fireEvent.keyDown(screen.getByRole('row'), { key: 'ArrowDown' });

    expect(focus().state.rowId).toBe('t2');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Flag-off Enter — the deselect arm.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — Enter toggles selection (flag-off)', () => {
  it('selects an unselected row', () => {
    renderPlain(<TaskListRow task={base} level={1} widths={widths} visible={visible} />);
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(useScheduleStore.getState().selectedTaskId).toBe('t1');
  });

  it('DESELECTS a row that is already selected (Enter is a toggle, not a set)', () => {
    useScheduleStore.setState({ selectedTaskId: 't1' });
    renderPlain(<TaskListRow task={base} level={1} widths={widths} visible={visible} />);
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Sprint-outcome key containment (ADR-0101 §2).
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — sprint-outcome panel key containment', () => {
  async function openWarnPanel() {
    const user = userEvent.setup();
    const { focus } = renderBuild();
    act(() => {
      focus().focusRow('t1');
      focus().enterCellEdit('t1', 'name');
    });
    const input = screen.getByLabelText('Rename item Design Phase');
    await user.clear(input);
    await user.type(input, 'Renamed{Enter}');
    await user.click(screen.getByTestId('sprint-pick'));
    const [, opts] = mocks.updateMutate.mock.calls.at(-1) as [
      unknown,
      { onSuccess: (d: unknown) => void },
    ];
    act(() =>
      opts.onSuccess({ warnings: [{ rule: 'phase_in_sprint', detail: 'Phase double-counts' }] }),
    );
    return { user, focus };
  }

  it('Escape typed inside the guardrail panel does not clear the row focus', async () => {
    const { focus } = await openWarnPanel();
    expect(screen.getByText('Phase double-counts')).toBeInTheDocument();
    act(() => focus().focusRow('t1'));

    // The key originates on the panel's own button, not on the row div.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep it here' }), { key: 'Escape' });

    // Build mode's Esc-clears-focus shortcut must NOT have run.
    expect(focus().state.mode).toBe('RowFocused');
    expect(screen.getByText('Phase double-counts')).toBeInTheDocument();
  });

  it('Space typed inside the guardrail panel does not toggle mark-complete', async () => {
    await openWarnPanel();
    mocks.toggleMutate.mockClear();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep it here' }), { key: ' ' });

    expect(mocks.toggleMutate).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ⋮⋮ reorder handle — pointer-up guards.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — ⋮⋮ grip starts a gesture it does not own (#347, #2954)', () => {
  beforeAll(() => {
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
  });

  it('hands the gesture to the list, naming the row it started on', () => {
    const onOutlineDragStart = vi.fn();
    renderBuild({ siblingIds: ['t1', 't2', 't3'], onOutlineDragStart });

    fireEvent.pointerDown(screen.getByTitle(/Drag to reorder/), { clientY: 0, pointerId: 1 });

    expect(onOutlineDragStart).toHaveBeenCalledTimes(1);
    expect(onOutlineDragStart.mock.calls[0][0]).toBe('t1');
  });

  it('never mutates from the row — the row cannot see what is under the pointer', () => {
    // The #347 grip resolved the drop itself, by rounding a pixel delta to a
    // sibling slot. It could only ever reorder, it showed nothing before
    // committing, and it was blind to the milestone and own-subtree refusals.
    // The row is now a starter and nothing else; every drop resolves in
    // `outlineDrag` and commits in `ScheduleView`.
    const onOutlineDragStart = vi.fn();
    renderBuild({ siblingIds: ['t1', 't2', 't3'], onOutlineDragStart });
    const handle = screen.getByTitle(/Drag to reorder/);

    fireEvent.pointerDown(handle, { clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 60, pointerId: 1 });

    expect(mocks.reorderMutate).not.toHaveBeenCalled();
  });

  it('is inert when no list is listening, rather than throwing', () => {
    renderBuild({ siblingIds: ['t1', 't2', 't3'] });
    const handle = screen.getByTitle(/Drag to reorder/);

    expect(() => fireEvent.pointerDown(handle, { clientY: 0, pointerId: 1 })).not.toThrow();
    expect(mocks.reorderMutate).not.toHaveBeenCalled();
  });

  it('shows a grip on a row with no siblingIds — presence tracks edit rights alone', () => {
    // Rule 302: the apparatus is present or absent, and what decides that is the
    // entitlement. A grip that vanished because the panel had not computed a
    // sibling map yet would read as "you may not edit this row".
    renderBuild({});
    expect(screen.getByTitle(/Drag to reorder/)).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Row-action error toasts — the 4 s auto-clear timers (#362 pattern).
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — schedule-error toast auto-clear', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the mark-complete failure toast after 4 s', () => {
    vi.useFakeTimers();
    renderPlain(<TaskListRow task={base} level={1} widths={widths} visible={visible} />);
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: ' ' });
    const [, opts] = mocks.toggleMutate.mock.calls[0] as [unknown, { onError: (e: unknown) => void }];

    act(() => opts.onError(new Error('boom')));
    expect(useScheduleStore.getState().scheduleError).toBe('Failed to update task status.');

    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(useScheduleStore.getState().scheduleError).toBe('Failed to update task status.');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(useScheduleStore.getState().scheduleError).toBeNull();
  });

  it('surfaces the structured progress-anchor detail rather than the generic copy', () => {
    renderPlain(<TaskListRow task={base} level={1} widths={widths} visible={visible} />);
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: ' ' });
    const [, opts] = mocks.toggleMutate.mock.calls[0] as [unknown, { onError: (e: unknown) => void }];

    act(() =>
      opts.onError({
        response: { data: { code: 'progress_requires_anchor', detail: 'Anchor the task first.' } },
      }),
    );
    expect(useScheduleStore.getState().scheduleError).toBe('Anchor the task first.');
  });

  it('clears the duplicate failure toast after 4 s', () => {
    vi.useFakeTimers();
    renderPlain(<TaskListRow task={base} level={1} widths={widths} visible={visible} />);
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: 'd', metaKey: true });
    const [, opts] = mocks.duplicateMutate.mock.calls[0] as [
      unknown,
      { onError: (e: unknown) => void },
    ];

    act(() => opts.onError(new Error('boom')));
    expect(useScheduleStore.getState().scheduleError).toBe('Failed to duplicate task.');

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(useScheduleStore.getState().scheduleError).toBeNull();
  });

  it('⌘D is a no-op with no project id in scope', () => {
    // renderWithRouter mounts at "/", so useProjectId → undefined → projectId ''.
    renderWithRouter(<TaskListRow task={base} level={1} widths={widths} visible={visible} />);
    const row = screen.getByRole('row');
    row.focus();
    fireEvent.keyDown(row, { key: 'd', metaKey: true });
    expect(mocks.duplicateMutate).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Right-click outside build mode (#806 guard's "no build mode" arm).
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — context menu', () => {
  it('opens no row menu and leaves the native menu alone outside build mode', () => {
    renderPlain(<TaskListRow task={base} level={1} widths={widths} visible={visible} />);
    const row = screen.getByRole('row');

    const notPrevented = fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });

    // fireEvent returns false when the handler called preventDefault.
    expect(notPrevented).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the row menu in build mode (control for the guard above)', () => {
    renderBuild();
    fireEvent.contextMenu(screen.getByRole('row'), { clientX: 10, clientY: 10 });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// "N planned" badge (#1798) — plural / empty-sprint-name arms.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — planned badge copy', () => {
  const summary: Task = { ...base, isSummary: true };

  it('names the single target sprint when there is exactly one', () => {
    renderPlain(
      <TaskListRow
        task={summary}
        level={1}
        widths={widths}
        visible={visible}
        plannedBadge={{ count: 3, primarySprintId: 's1', sprintNames: ['Sprint 4'] }}
      />,
    );
    expect(screen.getByTestId('planned-badge')).toHaveAttribute(
      'title',
      'Planned for Sprint 4 — not a committed date',
    );
  });

  it('falls back to the plural count phrasing when several sprints are targeted', () => {
    renderPlain(
      <TaskListRow
        task={summary}
        level={1}
        widths={widths}
        visible={visible}
        plannedBadge={{ count: 5, primarySprintId: 's1', sprintNames: ['Sprint 4', 'Sprint 5'] }}
      />,
    );
    const badge = screen.getByTestId('planned-badge');
    expect(badge).toHaveAttribute('title', '5 tasks planned for upcoming sprints — not committed dates');
    expect(badge).toHaveAccessibleName(
      '5 planned, targeted for Sprint 4, Sprint 5. Not committed dates. Activate to show in the Unscheduled tray.',
    );
  });

  it('omits the "targeted for" clause when no sprint names are known', () => {
    renderPlain(
      <TaskListRow
        task={summary}
        level={1}
        widths={widths}
        visible={visible}
        plannedBadge={{ count: 2, primarySprintId: null, sprintNames: [] }}
      />,
    );
    expect(screen.getByTestId('planned-badge')).toHaveAccessibleName(
      '2 planned. Not committed dates. Activate to show in the Unscheduled tray.',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Links cell — the typed flag (#3023).
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — Links cell flag', () => {
  it('names the type on a single non-critical predecessor, in neutral tone', () => {
    useScheduleStore.setState({ selectedTaskId: 't1' });
    renderPlain(
      <TaskListRow
        task={base}
        level={1}
        widths={widths}
        visible={visible}
        depChips={{
          preds: [{ type: 'FS', lag: 0 }],
          succs: [{ type: 'FS', lag: 0 }],
          predsCritical: false,
          succsCritical: false,
        }}
      />,
    );
    expect(screen.getByTestId('dep-flag-predecessor')).toHaveTextContent('←FS');
    expect(screen.getByTestId('dep-flag-successor')).toHaveTextContent('→FS');
    expect(screen.getByTestId('dep-flag-predecessor').className).not.toMatch(/semantic-critical/);
  });

  it('carries the critical tone when the chain is critical, and states the count', () => {
    useScheduleStore.setState({ selectedTaskId: 't1' });
    renderPlain(
      <TaskListRow
        task={base}
        level={1}
        widths={widths}
        visible={visible}
        depChips={{
          preds: [
            { type: 'FS', lag: 0 },
            { type: 'FS', lag: 0 },
            { type: 'FS', lag: 0 },
          ],
          succs: [
            { type: 'FS', lag: 0 },
            { type: 'SS', lag: 0 },
          ],
          predsCritical: true,
          succsCritical: true,
        }}
      />,
    );
    expect(screen.getByTestId('dep-flag-predecessor')).toHaveTextContent('←FS×3');
    expect(screen.getByTestId('dep-flag-predecessor').className).toMatch(/semantic-critical/);
    // Two types that DIFFER — an overlap, which a bare count could not say.
    expect(screen.getByTestId('dep-flag-successor')).toHaveTextContent('→FS·SS');
    expect(screen.getByTestId('dep-flag-successor').className).toMatch(/semantic-critical/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Finish cell — unscheduled arms.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — Finish cell', () => {
  it('labels a task with no finish date "unscheduled" and renders an em dash', () => {
    renderPlain(
      <TaskListRow
        task={{ ...base, finish: '' }}
        level={1}
        widths={widths}
        visible={visible}
      />,
    );
    const cell = screen.getByRole('gridcell', { name: 'unscheduled' });
    expect(cell).toHaveTextContent('—');
  });

  it('labels a scheduled task with its formatted finish date', () => {
    renderPlain(<TaskListRow task={base} level={1} widths={widths} visible={visible} />);
    expect(screen.getByRole('gridcell', { name: /^finishes / })).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Cell-edit traversal — Escape rollback, Tab / Shift-Tab out of each cell.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — Duration cell traversal (build mode)', () => {
  function enterDuration() {
    const { focus } = renderBuild();
    act(() => {
      focus().focusRow('t1');
      focus().enterCellEdit('t1', 'duration');
    });
    return { focus, input: screen.getByLabelText('Duration: 10 days. Press Enter to edit.') };
  }

  it('Escape rolls back to the row without a PATCH', () => {
    const { focus, input } = enterDuration();
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mocks.updateMutate).not.toHaveBeenCalled();
    expect(focus().state.mode).toBe('RowFocused');
  });

  it('Tab commits the duration and leaves the cell', () => {
    const { focus, input } = enterDuration();
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.keyDown(input, { key: 'Tab' });

    expect(mocks.updateMutate).toHaveBeenCalledWith({ id: 't1', projectId: 'p1', duration: 4 });
    expect(focus().state.mode).toBe('RowFocused');
    // Back to the read cell — the label now belongs to the gridcell, not an input.
    expect(screen.getByLabelText('Duration: 10 days. Press Enter to edit.').tagName).not.toBe(
      'INPUT',
    );
  });

  it('Shift-Tab also commits and leaves the cell', () => {
    const { focus, input } = enterDuration();
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });

    expect(mocks.updateMutate).toHaveBeenCalledWith({ id: 't1', projectId: 'p1', duration: 4 });
    expect(focus().state.mode).toBe('RowFocused');
  });
});

describe('TaskListRow — Progress cell traversal + error auto-clear (build mode)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function enterProgress() {
    const { focus } = renderBuild();
    act(() => {
      focus().focusRow('t1');
      focus().enterCellEdit('t1', 'progress');
    });
    return { focus, input: screen.getByLabelText('Progress: 50%. Press Enter to edit.') };
  }

  it('Escape rolls back to the row without a PATCH', () => {
    const { focus, input } = enterProgress();
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mocks.updateMutate).not.toHaveBeenCalled();
    expect(focus().state.mode).toBe('RowFocused');
  });

  it('Tab commits the percent and leaves the cell', () => {
    const { focus, input } = enterProgress();
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.keyDown(input, { key: 'Tab' });

    expect(mocks.updateMutate).toHaveBeenCalledWith(
      { id: 't1', projectId: 'p1', percent_complete: 90 },
      expect.objectContaining({ onError: expect.any(Function) as unknown }),
    );
    expect(focus().state.mode).toBe('RowFocused');
  });

  it('Shift-Tab also commits the percent and leaves the cell', () => {
    const { input } = enterProgress();
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });

    expect(mocks.updateMutate).toHaveBeenCalledWith(
      { id: 't1', projectId: 'p1', percent_complete: 90 },
      expect.objectContaining({ onError: expect.any(Function) as unknown }),
    );
    expect(screen.getByLabelText('Progress: 50%. Press Enter to edit.').tagName).not.toBe('INPUT');
  });

  it('clears the progress-anchor error toast after 5 s', () => {
    vi.useFakeTimers();
    const { input } = enterProgress();
    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const [, opts] = mocks.updateMutate.mock.calls[0] as [unknown, { onError: (e: unknown) => void }];

    act(() => opts.onError({ response: { data: { code: 'progress_requires_anchor' } } }));
    expect(useScheduleStore.getState().scheduleError).toMatch(/Planned Start date/);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(useScheduleStore.getState().scheduleError).toBeNull();
  });

  it('clears the rollup-locked error toast after 5 s', () => {
    vi.useFakeTimers();
    const { input } = enterProgress();
    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const [, opts] = mocks.updateMutate.mock.calls[0] as [unknown, { onError: (e: unknown) => void }];

    act(() =>
      opts.onError({
        response: { data: { code: 'milestone_rollup_locked', detail: 'x', suggested_action: 'y' } },
      }),
    );
    expect(useScheduleStore.getState().scheduleError).toMatch(/rolls up from sprint/);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(useScheduleStore.getState().scheduleError).toBeNull();
  });
});

describe('TaskListRow — Name cell traversal (build mode)', () => {
  it('Shift-Tab from the name cell commits and returns to the row', () => {
    const { focus } = renderBuild();
    act(() => {
      focus().focusRow('t1');
      focus().enterCellEdit('t1', 'name');
    });
    const input = screen.getByLabelText('Rename item Design Phase');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });

    expect(mocks.updateMutate).toHaveBeenCalledWith({
      id: 't1',
      projectId: 'p1',
      name: 'Renamed',
    });
    expect(focus().state.mode).toBe('RowFocused');
  });

  it('Escape dismisses the name-suggestion list along with the cell edit', async () => {
    const user = userEvent.setup();
    const { focus } = renderBuild({ nameSuggestions: ['Design Review', 'Deploy'] });
    act(() => {
      focus().focusRow('t1');
      focus().enterCellEdit('t1', 'name');
    });
    const input = screen.getByLabelText('Rename item Design Phase');
    await user.clear(input);
    await user.type(input, 'Des');
    expect(await screen.findByRole('listbox', { name: 'Task name suggestions' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox', { name: 'Task name suggestions' })).toBeNull();
    expect(mocks.updateMutate).not.toHaveBeenCalled();
    expect(focus().state.mode).toBe('RowFocused');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Milestone Start cell — keyboard activation (Enter AND Space).
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — milestone Start-cell keyboard activation (#345)', () => {
  const milestone: Task = { ...base, isMilestone: true, duration: 0, progress: 0 };

  it('opens the date popover on Space', () => {
    renderBuild({
      task: milestone,
      milestoneParents: [{ name: 'Design Phase', finish: '2026-10-20' }],
    });
    const startCell = screen.getByRole('gridcell', { name: /^starts / });

    fireEvent.keyDown(startCell, { key: ' ' });

    expect(screen.getByRole('dialog', { name: 'Pick milestone date' })).toBeInTheDocument();
  });

  it('opens the date popover on Enter', () => {
    renderBuild({
      task: milestone,
      milestoneParents: [{ name: 'Design Phase', finish: '2026-10-20' }],
    });
    const startCell = screen.getByRole('gridcell', { name: /^starts / });

    fireEvent.keyDown(startCell, { key: 'Enter' });

    expect(screen.getByRole('dialog', { name: 'Pick milestone date' })).toBeInTheDocument();
  });

  it('ignores other keys on the Start cell', () => {
    renderBuild({
      task: milestone,
      milestoneParents: [{ name: 'Design Phase', finish: '2026-10-20' }],
    });
    const startCell = screen.getByRole('gridcell', { name: /^starts / });

    fireEvent.keyDown(startCell, { key: 'ArrowRight' });

    expect(screen.queryByRole('dialog', { name: 'Pick milestone date' })).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Classic (flag-off) inline rename — the "nothing actually changed" commit arm.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — classic inline rename commit guard', () => {
  function startClassicRename() {
    renderPlain(<TaskListRow task={base} level={1} widths={widths} visible={visible} />);
    fireEvent.doubleClick(screen.getByRole('row'));
    return screen.getByLabelText<HTMLInputElement>('Rename item Design Phase');
  }

  it('PATCHes a genuinely new name', () => {
    const input = startClassicRename();
    fireEvent.change(input, { target: { value: 'Discovery' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mocks.updateMutate).toHaveBeenCalledWith({
      id: 't1',
      projectId: 'p1',
      name: 'Discovery',
    });
  });

  it('does not PATCH when the committed name is unchanged', () => {
    const input = startClassicRename();
    expect(input.value).toBe('Design Phase');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mocks.updateMutate).not.toHaveBeenCalled();
    // The edit still closes — a no-op commit is not a stuck input.
    expect(screen.queryByLabelText('Rename item Design Phase')).toBeNull();
  });

  it('does not PATCH a blank name (whitespace trims to empty)', () => {
    const input = startClassicRename();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mocks.updateMutate).not.toHaveBeenCalled();
    expect(screen.getByText('Design Phase')).toBeInTheDocument();
  });

  it('Escape abandons the edit without a PATCH', () => {
    const input = startClassicRename();
    fireEvent.change(input, { target: { value: 'Scrapped' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mocks.updateMutate).not.toHaveBeenCalled();
    expect(screen.getByText('Design Phase')).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Build mode with no project id in scope — every commit path must bail out of
// the PATCH while still returning focus to the row.
// ───────────────────────────────────────────────────────────────────────────
describe('TaskListRow — build-mode commits with no project id', () => {
  function renderBuildNoProject(props: Omit<HarnessProps, 'focusRef'> = {}) {
    const focusRef: { current: FocusApi | null } = { current: null };
    // renderWithRouter mounts at "/", so useProjectId → undefined → projectId ''.
    renderWithRouter(<Harness {...props} focusRef={focusRef} />);
    return { focus: () => focusRef.current as FocusApi };
  }

  it('a name commit issues no PATCH and never opens the sprint prompt', () => {
    const { focus } = renderBuildNoProject();
    act(() => {
      focus().focusRow('t1');
      focus().enterCellEdit('t1', 'name');
    });
    const input = screen.getByLabelText('Rename item Design Phase');
    fireEvent.change(input, { target: { value: 'Discovery' } });
    fireEvent.keyDown(input, { key: 'Tab' });

    expect(mocks.updateMutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sprint-pick')).toBeNull();
    expect(focus().state.mode).toBe('RowFocused');
  });

  it('a duration commit issues no PATCH', () => {
    const { focus } = renderBuildNoProject();
    act(() => {
      focus().focusRow('t1');
      focus().enterCellEdit('t1', 'duration');
    });
    const input = screen.getByLabelText('Duration: 10 days. Press Enter to edit.');
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mocks.updateMutate).not.toHaveBeenCalled();
    expect(focus().state.mode).toBe('RowFocused');
  });

  it('a progress commit issues no PATCH', () => {
    const { focus } = renderBuildNoProject();
    act(() => {
      focus().focusRow('t1');
      focus().enterCellEdit('t1', 'progress');
    });
    const input = screen.getByLabelText('Progress: 50%. Press Enter to edit.');
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mocks.updateMutate).not.toHaveBeenCalled();
    expect(focus().state.mode).toBe('RowFocused');
  });

  it('a milestone date pick issues no PATCH', async () => {
    const user = userEvent.setup();
    renderBuildNoProject({
      task: { ...base, isMilestone: true, duration: 0, progress: 0 },
      milestoneParents: [{ name: 'Design Phase', finish: '2026-10-20' }],
    });
    await user.click(screen.getByRole('gridcell', { name: /^starts / }));
    await user.click(screen.getByRole('button', { name: 'End of Design Phase' }));

    expect(mocks.updateMutate).not.toHaveBeenCalled();
  });
});
