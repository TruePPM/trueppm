/**
 * TaskFormModal — targeted branch/behavior coverage (#2235).
 *
 * A companion to TaskFormModal.test.tsx that exercises the save sequencer's
 * assignment/predecessor diff paths, the delete blast-radius, read-only
 * heuristics, the relative-time footer, the story-point / sprint-lock states,
 * agile-only duration suppression, the desktop scrim + mobile discard/delete
 * callbacks, and the multi-field 409 conflict banner. Uses fully mutable
 * let-bound mocks so each test can flex the project/schedule fixtures without
 * touching the module-level stubs baked into the sibling suite.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';
import type { Task } from '@/types';
import type {
  CyclicDependencyError,
  ProgressAnchorError,
} from '@/hooks/useTaskMutations';
import { TaskFormModal } from './index';

// --- Mutable fixtures ------------------------------------------------------
let mockTasks: Array<Partial<Task>> = [];
let mockLinks: Array<{ sourceId: string; targetId: string }> = [];
let mockProject: Record<string, unknown> = { agile_features: false };
let mockUserRole = 300;
let mockPool: Array<{ resource: { id: string; name: string }; roleTitle: string }> = [];
let mockSprints: Array<{ id: string; name: string; state: string }> = [];
let mockHistory: Array<{ history_date: string; history_user: string | null; diff: unknown[] }> = [];
let mockServerPredecessors: Array<{ id: string; predecessorId: string; successorId: string }> = [];
let mockPredsResolved = true;
let mockPredsError: Error | null = null;

const createMutate = vi.fn().mockResolvedValue({ id: 'new-task-id' });
const updateMutate = vi.fn().mockResolvedValue({});
const deleteMutate = vi.fn().mockResolvedValue(undefined);
const addAssignmentMutate = vi.fn().mockResolvedValue({ assignment: {}, warnings: [] });
const updateAssignmentMutate = vi.fn().mockResolvedValue({});
const removeAssignmentMutate = vi.fn().mockResolvedValue(undefined);
const addDependencyMutate = vi.fn().mockResolvedValue({});
const removeDependencyMutate = vi.fn().mockResolvedValue(undefined);

const toastSuccessSpy = vi.hoisted(() => vi.fn());
vi.mock('@/components/Toast', () => ({
  toast: { success: toastSuccessSpy, info: vi.fn(), error: vi.fn(), warm: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, links: mockLinks, isLoading: false, error: null }),
}));
vi.mock('@/hooks/useSprints', () => ({
  useSprints: () => ({ sprints: mockSprints, isLoading: false, error: null }),
}));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: mockProject, isLoading: false }),
}));
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: mockUserRole, isLoading: false }),
}));
vi.mock('@/hooks/useProjectResourcePool', () => ({
  useProjectResourcePool: () => ({ data: mockPool, isLoading: false }),
}));
vi.mock('@/hooks/useTaskHistory', () => ({
  useTaskHistory: () => ({ data: { pages: [{ results: mockHistory }] }, isLoading: false }),
}));
vi.mock('@/hooks/useTaskDependencies', () => ({
  useTaskDependencies: () => ({
    predecessors: mockServerPredecessors,
    successors: [],
    isLoading: false,
    isFetching: false,
    hasResolved: mockPredsResolved,
    error: mockPredsError,
  }),
}));

const mockParseCyclic = vi.hoisted(() =>
  vi.fn<() => CyclicDependencyError | null>(() => null),
);
const mockParseAnchor = vi.hoisted(() =>
  vi.fn<() => ProgressAnchorError | null>(() => null),
);
vi.mock('@/hooks/useTaskMutations', () => ({
  useCreateTask: () => ({ mutate: vi.fn(), mutateAsync: createMutate, isPending: false }),
  useUpdateTask: () => ({ mutate: vi.fn(), mutateAsync: updateMutate, isPending: false }),
  useDeleteTask: () => ({ mutate: vi.fn(), mutateAsync: deleteMutate, isPending: false }),
  useAddDependency: () => ({ mutate: vi.fn(), mutateAsync: addDependencyMutate, isPending: false }),
  useRemoveDependency: () => ({ mutate: vi.fn(), mutateAsync: removeDependencyMutate, isPending: false }),
  parseCyclicDependencyError: mockParseCyclic,
  formatCycleMessage: () => '',
  parseProgressAnchorError: mockParseAnchor,
}));
vi.mock('@/hooks/useAssignmentMutations', () => ({
  useAddAssignment: () => ({ mutate: vi.fn(), mutateAsync: addAssignmentMutate, isPending: false }),
  useUpdateAssignment: () => ({ mutate: vi.fn(), mutateAsync: updateAssignmentMutate, isPending: false }),
  useRemoveAssignment: () => ({ mutate: vi.fn(), mutateAsync: removeAssignmentMutate, isPending: false }),
}));

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 'edit-task-id',
    wbs: '1.1',
    name: 'Existing task',
    start: '2026-05-04',
    finish: '2026-05-08',
    plannedStart: '2026-05-04',
    duration: 5,
    progress: 30,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    assignees: [],
    notes: 'Original notes',
    ...over,
  } as Task;
}

function renderModal(props: Partial<Parameters<typeof TaskFormModal>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const merged: Parameters<typeof TaskFormModal>[0] = {
    projectId: 'project-1',
    task: null,
    isMobile: false,
    onClose: vi.fn(),
    ...props,
  };
  const result = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TaskFormModal {...merged} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, props: merged };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTasks = [
    { id: 'pred-a', wbs: '1', name: 'Predecessor A', isSummary: false, isMilestone: false } as Partial<Task>,
    { id: 'edit-task-id', wbs: '1.1', name: 'Existing task', isSummary: false, isMilestone: false } as Partial<Task>,
  ];
  mockLinks = [];
  mockProject = { agile_features: false };
  mockUserRole = 300;
  mockPool = [];
  mockSprints = [];
  mockHistory = [];
  mockServerPredecessors = [];
  mockPredsResolved = true;
  mockPredsError = null;
  mockParseCyclic.mockReturnValue(null);
  mockParseAnchor.mockReturnValue(null);
});

// ----- Relative-time footer (formatRelative) -------------------------------

describe('last-edited relative time', () => {
  function editedAgo(ms: number, user: string | null = 'Ada') {
    mockHistory = [
      { history_date: new Date(Date.now() - ms).toISOString(), history_user: user, diff: [] },
    ];
  }

  it('renders "just now" for a very recent edit', () => {
    editedAgo(10_000); // 10s
    renderModal({ task: baseTask() });
    expect(screen.getByText('Edited by Ada just now')).toBeInTheDocument();
  });

  it('renders hours for an edit a few hours ago', () => {
    editedAgo(3 * 60 * 60 * 1000);
    renderModal({ task: baseTask() });
    expect(screen.getByText('Edited by Ada 3h ago')).toBeInTheDocument();
  });

  it('renders days for an edit a few days ago', () => {
    editedAgo(2 * 24 * 60 * 60 * 1000);
    renderModal({ task: baseTask() });
    expect(screen.getByText('Edited by Ada 2d ago')).toBeInTheDocument();
  });

  it('renders months for an edit over a month ago', () => {
    editedAgo(65 * 24 * 60 * 60 * 1000);
    renderModal({ task: baseTask() });
    expect(screen.getByText('Edited by Ada 2mo ago')).toBeInTheDocument();
  });

  it('treats a future history_date as "just now"', () => {
    mockHistory = [
      { history_date: new Date(Date.now() + 60_000).toISOString(), history_user: 'Ada', diff: [] },
    ];
    renderModal({ task: baseTask() });
    expect(screen.getByText('Edited by Ada just now')).toBeInTheDocument();
  });
});

// ----- Submit-hint platform copy -------------------------------------------

describe('submit hint', () => {
  it('shows the Ctrl+S hint on a non-Mac platform in create mode', () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    try {
      renderModal();
      expect(screen.getByText('Ctrl+S to save')).toBeInTheDocument();
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
    }
  });

  it('shows the ⌘+S hint on a Mac platform in create mode', () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    try {
      renderModal();
      expect(screen.getByText('⌘+S to save')).toBeInTheDocument();
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
    }
  });
});

// ----- Editable fields feed the PATCH payload ------------------------------

it('edit mode: status, progress, and notes edits land in the PATCH payload', async () => {
  renderModal({ task: baseTask() });
  fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'COMPLETE' } });
  fireEvent.change(screen.getByLabelText('Progress'), { target: { value: '55' } });
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Revised notes' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await Promise.resolve();
  expect(updateMutate).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'COMPLETE', percent_complete: 55, notes: 'Revised notes' }),
  );
});

it('edit mode: a valid Duration entry is kept on blur (normalizes to the typed value)', () => {
  renderModal({ task: baseTask({ duration: 5 }) });
  const dur = screen.getByLabelText<HTMLInputElement>(/Duration/);
  fireEvent.change(dur, { target: { value: '9' } });
  fireEvent.blur(dur);
  expect(dur.value).toBe('9');
});

// ----- Create-mode sprint pre-seed (defaultSprintId) -----------------------

it('create mode: defaultSprintId pre-selects the sprint when agile_features is on', () => {
  mockProject = { agile_features: true };
  mockSprints = [{ id: 'sprint-1', name: 'Sprint One', state: 'PLANNED' }];
  renderModal({ defaultSprintId: 'sprint-1' });
  expect(screen.getByLabelText<HTMLSelectElement>('Sprint').value).toBe('sprint-1');
});

// ----- Sprint option rendering + points lock -------------------------------

describe('sprint selector + story-point lock', () => {
  it('lists non-cancelled sprints with a state suffix and excludes cancelled ones', () => {
    mockProject = { agile_features: true };
    mockSprints = [
      { id: 's-active', name: 'Active One', state: 'ACTIVE' },
      { id: 's-plan', name: 'Planned One', state: 'PLANNED' },
      { id: 's-cancel', name: 'Cancelled One', state: 'CANCELLED' },
    ];
    renderModal();
    const select = screen.getByLabelText<HTMLSelectElement>('Sprint');
    const labels = Array.from(select.options).map((o) => o.textContent?.trim());
    expect(labels).toContain('Active One');
    expect(labels?.some((l) => l === 'Planned One (planned)')).toBe(true);
    expect(labels?.some((l) => l?.includes('Cancelled One'))).toBe(false);
  });

  it('renders the points field read-only when the task is on an ACTIVE sprint', () => {
    mockProject = { agile_features: true };
    mockSprints = [{ id: 's-active', name: 'Active One', state: 'ACTIVE' }];
    renderModal({ task: baseTask({ sprintId: 's-active', storyPoints: 8 }) });
    // Read-only surface renders as a labelled div, not the editable Pts select.
    expect(screen.getByLabelText('Story points: 8')).toBeInTheDocument();
    expect(screen.queryByLabelText('Pts')).not.toBeInTheDocument();
  });

  it('an editable story-point selection lands in the create payload', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'Estimated task' } });
    fireEvent.change(screen.getByLabelText('Pts'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await Promise.resolve();
    expect(createMutate).toHaveBeenCalledWith(expect.objectContaining({ story_points: 5 }));
  });
});

// ----- Agile-only projects suppress the Duration field ---------------------

it('edit mode: a pure-agile project (methodology AGILE) hides the Duration field', () => {
  mockProject = { agile_features: true, methodology: 'AGILE' };
  renderModal({ task: baseTask() });
  expect(screen.queryByLabelText(/Duration/)).not.toBeInTheDocument();
  // Planned start still renders — only Duration is suppressed.
  expect(screen.getByLabelText('Planned start')).toBeInTheDocument();
});

// ----- Member read-only heuristic ------------------------------------------

describe('member ownership read-only heuristic', () => {
  it('renders read-only for a Member editing a task with no assignees', () => {
    mockUserRole = 100; // ROLE_MEMBER
    renderModal({ task: baseTask({ assignees: [] }) });
    expect(screen.getByText('VIEW TASK')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('keeps the form editable for a Member when the task has assignees', () => {
    mockUserRole = 100;
    renderModal({
      task: baseTask({ assignees: [{ resourceId: 'r1', name: 'Alice', units: 1 }] }),
    });
    expect(screen.getByText('EDIT TASK')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });
});

// ----- Assignee diff (syncAssignments) -------------------------------------

describe('assignee save sequencer', () => {
  it('adding a new assignee POSTs it through addAssignment on save', async () => {
    mockPool = [{ resource: { id: 'r-bob', name: 'Bob Stone' }, roleTitle: 'Engineer' }];
    renderModal({ task: baseTask() });
    fireEvent.change(screen.getByLabelText('Search people to assign'), { target: { value: 'Bob' } });
    fireEvent.click(await screen.findByRole('button', { name: /Bob Stone/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(addAssignmentMutate).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'edit-task-id', resourceId: 'r-bob', units: 1 }),
    );
  });

  it('editing an existing assignee\'s units keeps the row and does not remove it', async () => {
    renderModal({
      task: baseTask({ assignees: [{ resourceId: 'r1', name: 'Alice', units: 0.5 }] }),
    });
    const pct = screen.getByLabelText<HTMLInputElement>('Allocation percent for Alice');
    expect(pct.value).toBe('50');
    fireEvent.change(pct, { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await Promise.resolve();
    await Promise.resolve();
    // The working row lacks a server assignmentId, so neither add nor remove fires.
    expect(addAssignmentMutate).not.toHaveBeenCalled();
    expect(removeAssignmentMutate).not.toHaveBeenCalled();
  });

  it('removing an existing assignee drops the row from the working copy', async () => {
    renderModal({
      task: baseTask({ assignees: [{ resourceId: 'r1', name: 'Alice', units: 0.5 }] }),
    });
    expect(screen.getByText('Alice')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Alice' }));
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await Promise.resolve();
    // No known assignmentId, so no DELETE fires — server reconciles on refetch.
    expect(removeAssignmentMutate).not.toHaveBeenCalled();
  });

  it('surfaces a non-blocking warning when the assignment tail fails after the task saved', async () => {
    mockPool = [{ resource: { id: 'r-bob', name: 'Bob Stone' }, roleTitle: '' }];
    addAssignmentMutate.mockRejectedValueOnce(new Error('assignment blew up'));
    const onClose = vi.fn();
    renderModal({ task: baseTask(), onClose });
    fireEvent.change(screen.getByLabelText('Search people to assign'), { target: { value: 'Bob' } });
    fireEvent.click(await screen.findByRole('button', { name: /Bob Stone/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText(/Saved task, but updating assignments or dependencies failed: assignment blew up/),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the generic tail-failure copy when the rejection is not an Error', async () => {
    mockPool = [{ resource: { id: 'r-bob', name: 'Bob Stone' }, roleTitle: '' }];
    addAssignmentMutate.mockRejectedValueOnce('just a string');
    renderModal({ task: baseTask() });
    fireEvent.change(screen.getByLabelText('Search people to assign'), { target: { value: 'Bob' } });
    fireEvent.click(await screen.findByRole('button', { name: /Bob Stone/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('Saved task, but updating assignments or dependencies failed.'),
    ).toBeInTheDocument();
  });
});

// ----- Predecessor hydration + removal (syncPredecessors) ------------------

describe('predecessor hydration + removal', () => {
  it('hydrates the working predecessor list from the resolved dependency query', async () => {
    mockServerPredecessors = [
      { id: 'dep-1', predecessorId: 'pred-a', successorId: 'edit-task-id' },
    ];
    renderModal({ task: baseTask() });
    // Named row appears once the hydration effect runs.
    expect(await screen.findByText(/Predecessor A/)).toBeInTheDocument();
  });

  it('removing a hydrated predecessor fires removeDependency with the edge id on save', async () => {
    mockServerPredecessors = [
      { id: 'dep-1', predecessorId: 'pred-a', successorId: 'edit-task-id' },
    ];
    renderModal({ task: baseTask() });
    await screen.findByText(/Predecessor A/);
    fireEvent.click(screen.getByRole('button', { name: /Remove predecessor Predecessor A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(removeDependencyMutate).toHaveBeenCalledWith({
        id: 'dep-1',
        predecessor: 'pred-a',
        successor: 'edit-task-id',
      }),
    );
  });
});

// ----- Delete blast radius --------------------------------------------------

it('delete confirm quantifies the cascade of subtasks and dependency edges', () => {
  mockUserRole = 400;
  mockTasks = [
    { id: 'edit-task-id', wbs: '1.1', name: 'Existing task', isSubtask: false } as Partial<Task>,
    { id: 'sub-1', wbs: '1.1.1', name: 'Child A', isSubtask: true } as Partial<Task>,
    { id: 'sub-2', wbs: '1.1.2', name: 'Child B', isSubtask: true } as Partial<Task>,
  ];
  mockLinks = [{ sourceId: 'edit-task-id', targetId: 'other' }];
  renderModal({ task: baseTask({ name: 'Parent' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
  const dialog = screen.getByRole('alertdialog');
  expect(within(dialog).getByText(/2 subtasks and 1 dependency link/)).toBeInTheDocument();
});

// ----- Desktop scrim ------------------------------------------------------

describe('desktop backdrop', () => {
  it('closes immediately when the backdrop is clicked and the form is pristine', () => {
    const onClose = vi.fn();
    const { container } = renderModal({ onClose });
    const scrim = container.querySelector('div[aria-hidden="true"]');
    expect(scrim).not.toBeNull();
    fireEvent.pointerDown(scrim!);
    expect(onClose).toHaveBeenCalled();
  });

  it('prompts to discard when the backdrop is clicked and the form is dirty', () => {
    const onClose = vi.fn();
    const { container } = renderModal({ onClose });
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'unsaved' } });
    const scrim = container.querySelector('div[aria-hidden="true"]');
    fireEvent.pointerDown(scrim!);
    expect(screen.getByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ----- Mobile shell callbacks ---------------------------------------------

describe('mobile shell', () => {
  it('mobile: Cancel while dirty opens the discard dialog and Discard closes', () => {
    const onClose = vi.fn();
    renderModal({ isMobile: true, onClose });
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Discard unsaved changes?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('mobile: "Keep editing" on the discard dialog dismisses it and keeps the form open', () => {
    const onClose = vi.fn();
    renderModal({ isMobile: true, onClose });
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Discard unsaved changes?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('mobile: the delete dialog Cancel button dismisses without deleting', () => {
    mockUserRole = 400;
    renderModal({ task: baseTask(), isMobile: true });
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it('mobile: confirming delete calls deleteTask and closes', async () => {
    mockUserRole = 400;
    const onClose = vi.fn();
    renderModal({ task: baseTask(), isMobile: true, onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(deleteMutate).toHaveBeenCalledWith('edit-task-id');
    expect(onClose).toHaveBeenCalled();
  });
});

// ----- Multi-field 409 conflict banner -------------------------------------

function makeConflictError(overrides: Record<string, unknown> = {}): AxiosError {
  const err = new AxiosError('Conflict');
  err.response = {
    status: 409,
    statusText: 'Conflict',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: {
      code: 'sync_conflict',
      detail: 'Someone else changed this.',
      conflict_fields: ['name'],
      server_value: { name: 'Their name' },
      client_value: {},
      server_version: 9,
      ...overrides,
    },
  };
  return err;
}

it('conflict banner joins multiple fields, labels an unknown field, and omits blank server values', async () => {
  updateMutate.mockRejectedValueOnce(
    makeConflictError({
      conflict_fields: ['name', 'custom_widget'],
      server_value: { name: null, custom_widget: { nested: true } },
    }),
  );
  renderModal({ task: baseTask({ serverVersion: 3 }) });
  fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'My edit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  const banner = await screen.findByRole('alert');
  // Multiple fields → natural-language "A and B" list, unknown field humanized.
  expect(banner).toHaveTextContent(/Name and Custom widget/);
  // Neither a null nor an object server value renders a "now …" clause.
  expect(banner).not.toHaveTextContent(/now “/);
});

// ----- Footer Cancel while pristine closes directly (no discard prompt) -----

it('clicking Cancel on a pristine form closes immediately without a discard prompt', () => {
  const onClose = vi.fn();
  renderModal({ onClose });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalled();
  expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
});

// ----- Predecessor add happy-path (syncPredecessors added loop) -------------
// The cycle suite only exercises the REJECT path of addDependency. This locks
// in the success path: a newly-picked predecessor is POSTed on save and the
// modal closes (line 580 happy branch).

it('adding a predecessor POSTs it through addDependency and closes on save', async () => {
  const onClose = vi.fn();
  renderModal({ task: baseTask(), onClose });
  fireEvent.click(screen.getByRole('button', { name: /link predecessor/i }));
  fireEvent.change(screen.getByLabelText(/search predecessor tasks/i), {
    target: { value: 'Predecessor A' },
  });
  fireEvent.click(await screen.findByRole('button', { name: /Predecessor A/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(addDependencyMutate).toHaveBeenCalledWith({
      predecessor: 'pred-a',
      successor: 'edit-task-id',
    }),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

// ----- Sprint selection reaches the PATCH/POST payload (agile projects) -----
// The `agile_features ? { sprint } : {}` spread and the sprint <select>'s
// onChange (lines 630/656/996) only run on an agile project.

it('create mode: changing the Sprint select puts the sprint id in the create payload', async () => {
  mockProject = { agile_features: true };
  mockSprints = [
    { id: 's-plan', name: 'Sprint Plan', state: 'PLANNED' },
    { id: 's-active', name: 'Sprint Active', state: 'ACTIVE' },
  ];
  renderModal();
  fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'Planned work' } });
  fireEvent.change(screen.getByLabelText('Sprint'), { target: { value: 's-plan' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await Promise.resolve();
  expect(createMutate).toHaveBeenCalledWith(expect.objectContaining({ sprint: 's-plan' }));
});

it('edit mode: clearing the Sprint select sends sprint:null on an agile project', async () => {
  mockProject = { agile_features: true };
  mockSprints = [{ id: 's-plan', name: 'Sprint Plan', state: 'PLANNED' }];
  renderModal({ task: baseTask({ sprintId: 's-plan' }) });
  const sprint = screen.getByLabelText<HTMLSelectElement>('Sprint');
  expect(sprint.value).toBe('s-plan');
  fireEvent.change(sprint, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await Promise.resolve();
  expect(updateMutate).toHaveBeenCalledWith(expect.objectContaining({ sprint: null }));
});

it('non-agile create omits the sprint key entirely from the payload', async () => {
  mockProject = { agile_features: false };
  renderModal();
  fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'No sprint here' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await Promise.resolve();
  const payload = createMutate.mock.calls[0][0] as Record<string, unknown>;
  expect('sprint' in payload).toBe(false);
});

// ----- Duration flooring on keyboard submit (#1974) ------------------------
// A ⌘+S submit can fire while the Duration field holds a transient sub-1 value
// that never blurred; handleSubmit floors it to 1 before sending (line 611
// false branch). Edit mode is used because create mode's formIsValid gate
// blocks submit on a sub-1 duration.

it('edit mode: a sub-1 Duration is floored to 1 in the PATCH payload on ⌘+S (#1974)', async () => {
  renderModal({ task: baseTask({ duration: 5 }) });
  const dur = screen.getByLabelText<HTMLInputElement>(/Duration/);
  // Type "0" without blurring, then keyboard-submit — the field's own blur
  // normalizer never runs, so handleSubmit must floor it.
  fireEvent.change(dur, { target: { value: '0' } });
  expect(dur.value).toBe('0');
  fireEvent.keyDown(document, { key: 's', metaKey: true });
  await Promise.resolve();
  expect(updateMutate).toHaveBeenCalledWith(expect.objectContaining({ duration: 1 }));
});

// ----- Non-Error rejection fallback copy (outer catch, line 707) -----------

it('surfaces the generic save-error copy when create rejects with a non-Error value', async () => {
  createMutate.mockRejectedValueOnce('kaboom string');
  const onClose = vi.fn();
  renderModal({ onClose });
  fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'Doomed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await Promise.resolve();
  await Promise.resolve();
  expect(await screen.findByText(/Couldn.t save the task\. Try again\./)).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});

// ----- Predecessor hydration transient-failure guard #2 (#354, line 416) ---
// Once pristine holds real predecessors, a later empty resolve (a 401/transient
// refetch that returns []) must NOT wipe the working copy.

it('does not wipe hydrated predecessors when a later dependency resolve returns empty (#354)', async () => {
  mockServerPredecessors = [
    { id: 'dep-1', predecessorId: 'pred-a', successorId: 'edit-task-id' },
  ];
  const { rerender } = renderModal({ task: baseTask() });
  // First resolve hydrates the row.
  expect(await screen.findByText(/Predecessor A/)).toBeInTheDocument();
  // Simulate a transient empty refetch and force the hydration effect to re-run.
  mockServerPredecessors = [];
  rerender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TaskFormModal projectId="project-1" task={baseTask()} isMobile={false} onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // Guard #2 skips the overwrite — the predecessor stays visible.
  expect(screen.getByText(/Predecessor A/)).toBeInTheDocument();
});
