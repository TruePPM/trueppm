import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { SprintSection } from './SprintSection';
import type { Task, ApiSprint } from '@/types';
import { ROLE_VIEWER } from '@/lib/roles';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockTasks: Task[] = [];
vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, links: [], isLoading: false, error: null }),
}));

let mockSprints: ApiSprint[] = [];
let mockSprintsLoading = false;
vi.mock('@/hooks/useSprints', () => ({
  useSprints: () => ({ sprints: mockSprints, isLoading: mockSprintsLoading, error: null }),
  useActiveSprint: () => ({ sprint: null }),
}));

/** The variables SprintSection passes to `updateTask`. */
interface UpdateVars {
  id: string;
  projectId: string;
  sprint: string | null;
}
/** The per-call callbacks SprintSection attaches to the guardrail-aware write. */
interface MutateCallbacks {
  onSuccess?: (data: unknown) => void;
  onError?: (err: unknown) => void;
}

let mockMutate = vi.fn<(vars: UpdateVars, callbacks?: MutateCallbacks) => void>();
let mockIsPending = false;

// Keep the REAL `parseGuardrailWarnings` / `parseGuardrailBlockedError` — the
// section's warn/block branches are driven by feeding real server payload shapes
// through them, so stubbing them would test the stub instead of the parser.
vi.mock('@/hooks/useTaskMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTaskMutations')>();
  return {
    ...actual,
    useUpdateTask: () => ({ mutate: mockMutate, isPending: mockIsPending }),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseTask: Task = {
  id: 't1',
  wbs: '1',
  name: 'Widget work',
  start: '2026-04-01',
  finish: '2026-04-10',
  duration: 7,
  progress: 0,
  parentId: null,
  isCritical: false,
  isComplete: false,
  isSummary: false,
  isMilestone: false,
  status: 'NOT_STARTED',
  assignees: [],
  notes: '',
  optimisticDuration: null,
  mostLikelyDuration: null,
  pessimisticDuration: null,
  estimateStatus: null,
  sprintId: null,
};

const activeSprint: ApiSprint = {
  id: 'sprint-1',
  server_version: 1,
  short_id: 'SP-1',
  short_id_display: 'SP-1',
  name: 'Sprint 1',
  goal: '',
  notes: '',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  capacity_points: null,
  wip_limit: null,
  committed_points: 8,
  committed_task_count: 1,
  completed_points: 0,
  completed_task_count: 0,
  completion_ratio_points: null,
  completion_ratio_tasks: null,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

const plannedSprint: ApiSprint = {
  ...activeSprint,
  id: 'sprint-2',
  name: 'Sprint 2',
  state: 'PLANNED',
  start_date: '2026-04-15',
  finish_date: '2026-04-28',
  activated_at: null,
};

/** Replace the mocked schedule-task list in place (the mock closes over it). */
function setTasks(...tasks: Task[]) {
  mockTasks.splice(0, mockTasks.length, ...tasks);
}

/** The callbacks object handed to `updateTask` on the Nth mutate call. */
function callbacksOf(callIndex: number): MutateCallbacks {
  const callbacks = mockMutate.mock.calls[callIndex][1];
  if (!callbacks) throw new Error(`mutate call ${callIndex} carried no callbacks`);
  return callbacks;
}

beforeEach(() => {
  setTasks();
  mockSprints = [];
  mockSprintsLoading = false;
  mockIsPending = false;
  mockMutate = vi.fn<(vars: UpdateVars, callbacks?: MutateCallbacks) => void>();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SprintSection', () => {
  it('returns null when task is not found', () => {
    const { container } = renderWithProviders(<SprintSection taskId="missing" projectId="p1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows empty-state message when no assignable sprints and task has no sprint', () => {
    setTasks(baseTask);
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.getByText(/No active or planned sprints/i)).toBeInTheDocument();
  });

  it('renders the sprint selector when assignable sprints exist', () => {
    setTasks(baseTask);
    mockSprints = [activeSprint, plannedSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.getByRole('combobox', { name: /Sprint assignment/i })).toBeInTheDocument();
  });

  it('shows Active badge and dates when task is in an active sprint', () => {
    setTasks({ ...baseTask, sprintId: 'sprint-1' });
    mockSprints = [activeSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    // Date range appears in the tppm-mono badge span (not the option text)
    expect(screen.getAllByText(/2026-04-01/).length).toBeGreaterThan(0);
  });

  it('shows Remove button when task is assigned to a sprint', () => {
    setTasks({ ...baseTask, sprintId: 'sprint-1' });
    mockSprints = [activeSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.getByRole('button', { name: /Remove from sprint/i })).toBeInTheDocument();
  });

  it('shows Planned badge for a planned sprint', () => {
    setTasks({ ...baseTask, sprintId: 'sprint-2' });
    mockSprints = [plannedSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" />);
    expect(screen.getByText('Planned')).toBeInTheDocument();
  });

  it('does not show Remove button when task has no sprint', () => {
    setTasks(baseTask);
    mockSprints = [activeSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" />);
    expect(screen.queryByRole('button', { name: /Remove from sprint/i })).not.toBeInTheDocument();
  });

  it('excludes a phase from the picker and explains why (ADR-0293, #1755)', () => {
    // A phase: a non-subtask task with a structural (non-subtask) child. The picker
    // must not offer it as a sprint target — the API hard-blocks it unconditionally.
    const structuralChild: Task = {
      ...baseTask,
      id: 't1-child',
      wbs: '1.1',
      name: 'Inside work',
      parentId: 't1',
    };
    setTasks(baseTask, structuralChild);
    mockSprints = [activeSprint, plannedSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);
    // No selectable sprint control is rendered.
    expect(screen.queryByRole('combobox', { name: /Sprint assignment/i })).not.toBeInTheDocument();
    // Outcome-language guidance is shown instead.
    expect(screen.getByText(/Phases group work/i)).toBeInTheDocument();
  });

  it('still offers the picker for a leaf-with-subtasks summary (not a phase)', () => {
    // Its only child is a drawer subtask (isSubtask), a legitimately committable
    // decomposition — it must NOT be structurally excluded like a phase.
    const subtaskChild: Task = {
      ...baseTask,
      id: 't1-sub',
      wbs: '1.1',
      name: 'Checklist item',
      parentId: 't1',
      isSubtask: true,
    };
    setTasks(baseTask, subtaskChild);
    mockSprints = [activeSprint, plannedSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.getByRole('combobox', { name: /Sprint assignment/i })).toBeInTheDocument();
    expect(screen.queryByText(/Phases group work/i)).not.toBeInTheDocument();
  });

  // ----- Loading + read-only rendering ---------------------------------------

  it('renders a labelled loading placeholder instead of the picker while sprints load', () => {
    setTasks(baseTask);
    mockSprintsLoading = true;
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.getByLabelText('Loading sprints')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Sprint assignment/i })).not.toBeInTheDocument();
  });

  it('shows the assigned sprint as static text for a read-only viewer', () => {
    setTasks({ ...baseTask, sprintId: 'sprint-1' });
    mockSprints = [activeSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" userRole={ROLE_VIEWER} />);
    expect(screen.getByText('Sprint 1')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Sprint assignment/i })).not.toBeInTheDocument();
    // No write affordance is offered to a Viewer.
    expect(screen.queryByRole('button', { name: /Remove from sprint/i })).not.toBeInTheDocument();
  });

  it('reads "Not assigned" for a read-only viewer on an unassigned task', () => {
    setTasks(baseTask);
    mockSprints = [activeSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" userRole={ROLE_VIEWER} />);
    expect(screen.getByText('Not assigned')).toBeInTheDocument();
  });

  it('falls back to the client role rule when the server verdict is absent', () => {
    // canEdit undefined + a Member role → canEditTask(100) is true, so the
    // picker renders even though no server-derived verdict was threaded down.
    setTasks(baseTask);
    mockSprints = [activeSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" userRole={100} />);
    expect(screen.getByRole('combobox', { name: /Sprint assignment/i })).toBeInTheDocument();
  });

  it('disables both write controls while a sprint write is in flight', () => {
    setTasks({ ...baseTask, sprintId: 'sprint-1' });
    mockSprints = [activeSprint, plannedSprint];
    mockIsPending = true;
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.getByRole('combobox', { name: /Sprint assignment/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Remove from sprint/i })).toBeDisabled();
  });

  // ----- Assignment writes ---------------------------------------------------

  it('assigns the chosen sprint when the picker changes', () => {
    setTasks(baseTask);
    mockSprints = [activeSprint, plannedSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);

    fireEvent.change(screen.getByRole('combobox', { name: /Sprint assignment/i }), {
      target: { value: 'sprint-2' },
    });

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate.mock.calls[0][0]).toEqual({
      id: 't1',
      projectId: 'p1',
      sprint: 'sprint-2',
    });
  });

  it('clears the assignment when the "no sprint" option is picked', () => {
    setTasks({ ...baseTask, sprintId: 'sprint-1' });
    mockSprints = [activeSprint, plannedSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);

    fireEvent.change(screen.getByRole('combobox', { name: /Sprint assignment/i }), {
      target: { value: '' },
    });

    expect(mockMutate.mock.calls[0][0]).toEqual({ id: 't1', projectId: 'p1', sprint: null });
  });

  it('clears the assignment from the Remove control', () => {
    setTasks({ ...baseTask, sprintId: 'sprint-1' });
    mockSprints = [activeSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);

    fireEvent.click(screen.getByRole('button', { name: /Remove from sprint/i }));

    expect(mockMutate.mock.calls[0][0]).toEqual({ id: 't1', projectId: 'p1', sprint: null });
  });

  // ----- Guardrail warn path (ADR-0101 Tier 1) -------------------------------

  function assignAndWarn(detail: string) {
    setTasks({ ...baseTask, sprintId: 'sprint-1' });
    mockSprints = [activeSprint, plannedSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.change(screen.getByRole('combobox', { name: /Sprint assignment/i }), {
      target: { value: 'sprint-2' },
    });
    act(() => {
      callbacksOf(0).onSuccess?.({ warnings: [{ rule: 'summary_in_sprint', detail }] });
    });
  }

  it('surfaces a warn-level guardrail after a successful assignment', () => {
    assignAndWarn('Committing a parent double-counts its children in velocity.');
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(/double-counts its children in velocity/);
  });

  it('shows no guardrail notice when the write came back clean', () => {
    setTasks(baseTask);
    mockSprints = [activeSprint, plannedSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.change(screen.getByRole('combobox', { name: /Sprint assignment/i }), {
      target: { value: 'sprint-2' },
    });
    act(() => {
      callbacksOf(0).onSuccess?.({ warnings: [] });
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('dismisses the warn notice on "Keep it here" without re-writing', () => {
    assignAndWarn('Committing a parent double-counts its children in velocity.');
    fireEvent.click(screen.getByRole('button', { name: /Keep it here/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // Keep is a pure dismissal — the assignment already stuck server-side.
    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  it('reverts to the prior sprint on Undo', () => {
    assignAndWarn('Committing a parent double-counts its children in velocity.');
    fireEvent.click(screen.getByRole('button', { name: /^Undo$/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // Second write restores exactly what was assigned before the change.
    expect(mockMutate).toHaveBeenCalledTimes(2);
    expect(mockMutate.mock.calls[1][0]).toEqual({
      id: 't1',
      projectId: 'p1',
      sprint: 'sprint-1',
    });
  });

  it('undoes back to "no sprint" when the task started unassigned', () => {
    setTasks(baseTask);
    mockSprints = [activeSprint, plannedSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.change(screen.getByRole('combobox', { name: /Sprint assignment/i }), {
      target: { value: 'sprint-1' },
    });
    act(() => {
      callbacksOf(0).onSuccess?.({
        warnings: [{ rule: 'task_outside_sprint_window', detail: 'Task runs past the end.' }],
      });
    });
    fireEvent.click(screen.getByRole('button', { name: /^Undo$/i }));
    expect(mockMutate.mock.calls[1][0]).toEqual({ id: 't1', projectId: 'p1', sprint: null });
  });

  // ----- Guardrail block path (ADR-0101 Tier 2) ------------------------------

  function assignAndBlock() {
    setTasks(baseTask);
    mockSprints = [activeSprint, plannedSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.change(screen.getByRole('combobox', { name: /Sprint assignment/i }), {
      target: { value: 'sprint-1' },
    });
    act(() => {
      callbacksOf(0).onError?.({
        response: {
          data: {
            code: 'guardrail_blocked',
            rule: 'summary_in_sprint',
            detail: 'This parent cannot be committed — assign its children instead.',
            suggested_action: 'Assign the child tasks.',
          },
        },
      });
    });
  }

  it('shows a non-overridable block notice when the Owner escalated the rule', () => {
    assignAndBlock();
    expect(screen.getByRole('alert')).toHaveTextContent(/assign its children instead/);
    // A block offers no override — only an acknowledgement.
    expect(screen.queryByRole('button', { name: /Keep it here/i })).not.toBeInTheDocument();
  });

  it('clears the block notice on acknowledgement', () => {
    assignAndBlock();
    fireEvent.click(screen.getByRole('button', { name: /Got it/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores a non-guardrail write failure', () => {
    setTasks(baseTask);
    mockSprints = [activeSprint, plannedSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);
    fireEvent.change(screen.getByRole('combobox', { name: /Sprint assignment/i }), {
      target: { value: 'sprint-1' },
    });
    act(() => {
      callbacksOf(0).onError?.(new Error('network down'));
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // ----- Scope changes (ADR-0101 / ADR-0102) ---------------------------------

  it('lists scope-change rows, flagging goal impact and attribution when present', () => {
    setTasks({
      ...baseTask,
      sprintId: 'sprint-1',
      sprintScopeChanges: [
        {
          subtaskName: 'Extra QA pass',
          itemName: 'Extra QA pass',
          addedByName: 'Dana Reyes',
          addedAt: '2026-04-06T09:00:00Z',
          goalImpact: true,
        },
      ],
    });
    mockSprints = [activeSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);

    expect(screen.getByText('Scope changes')).toBeInTheDocument();
    expect(screen.getByText('Extra QA pass')).toBeInTheDocument();
    expect(screen.getByText('· affects goal')).toBeInTheDocument();
    expect(screen.getByText(/added by Dana Reyes/)).toBeInTheDocument();
  });

  it('omits the goal-impact and attribution fragments when the row carries neither', () => {
    setTasks({
      ...baseTask,
      sprintId: 'sprint-1',
      sprintScopeChanges: [
        {
          subtaskName: 'Follow-up note',
          itemName: 'Follow-up note',
          addedByName: null,
          addedAt: '2026-04-07T09:00:00Z',
          goalImpact: false,
        },
      ],
    });
    mockSprints = [activeSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);

    expect(screen.getByText('Follow-up note')).toBeInTheDocument();
    expect(screen.queryByText('· affects goal')).not.toBeInTheDocument();
    expect(screen.queryByText(/added by/)).not.toBeInTheDocument();
  });

  it('renders no scope-change block when the list is empty', () => {
    setTasks({ ...baseTask, sprintId: 'sprint-1', sprintScopeChanges: [] });
    mockSprints = [activeSprint];
    renderWithProviders(<SprintSection taskId="t1" projectId="p1" canEdit />);
    expect(screen.queryByText('Scope changes')).not.toBeInTheDocument();
  });
});
