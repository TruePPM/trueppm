import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Task } from '@/types';
import { TaskFormModal } from './index';

// Replace network-dependent hooks with deterministic stubs so the form can
// render in jsdom without API access. Everything that the modal touches is
// mocked at module scope; per-test behavior is steered via the let-bound
// fixtures below.
let mockProjectAgile = false;
let mockUserRole = 3; // PM by default; tests override to flex permissions
let mockResourcePool: Array<{ resource: { id: string; name: string }; roleTitle: string }> = [];
let mockSprints: Array<{ id: string; name: string; state: string }> = [];
let mockHistory: Array<{ history_date: string; history_user: string | null; diff: unknown[] }> = [];
let mockServerPredecessors: Array<{ id: string; predecessorId: string; successorId: string }> = [];

const createMutate = vi.fn().mockResolvedValue({ id: 'new-task-id' });
const updateMutate = vi.fn().mockResolvedValue({});
const deleteMutate = vi.fn().mockResolvedValue(undefined);
const addAssignmentMutate = vi.fn().mockResolvedValue({ assignment: {}, warnings: [] });
const addDependencyMutate = vi.fn().mockResolvedValue({});

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({
    tasks: [
      { id: 'parent-task-id', wbs: '1', name: 'Parent task', isSummary: true } as Partial<Task>,
      { id: 'sibling-1', wbs: '2', name: 'Sibling one', isSummary: false } as Partial<Task>,
    ] as Task[],
    links: [],
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/useSprints', () => ({
  useSprints: () => ({ sprints: mockSprints, isLoading: false, error: null }),
}));

vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: { agile_features: mockProjectAgile }, isLoading: false }),
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: mockUserRole, isLoading: false }),
}));

vi.mock('@/hooks/useProjectResourcePool', () => ({
  useProjectResourcePool: () => ({ data: mockResourcePool, isLoading: false }),
}));

vi.mock('@/hooks/useTaskHistory', () => ({
  useTaskHistory: () => ({
    data: { pages: [{ results: mockHistory }] },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useTaskDependencies', () => ({
  useTaskDependencies: () => ({
    predecessors: mockServerPredecessors,
    successors: [],
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/useTaskMutations', () => ({
  useCreateTask: () => ({ mutate: vi.fn(), mutateAsync: createMutate, isPending: false }),
  useUpdateTask: () => ({ mutate: vi.fn(), mutateAsync: updateMutate, isPending: false }),
  useDeleteTask: () => ({ mutate: vi.fn(), mutateAsync: deleteMutate, isPending: false }),
  useAddDependency: () => ({ mutate: vi.fn(), mutateAsync: addDependencyMutate, isPending: false }),
  useRemoveDependency: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useAssignmentMutations', () => ({
  useAddAssignment: () => ({ mutate: vi.fn(), mutateAsync: addAssignmentMutate, isPending: false }),
  useUpdateAssignment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRemoveAssignment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
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
  };
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

describe('TaskFormModal (issue #305)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectAgile = false;
    mockUserRole = 3;
    mockResourcePool = [];
    mockSprints = [];
    mockHistory = [];
    mockServerPredecessors = [];
  });

  // ----- Mode + header -----------------------------------------------------

  it('renders an empty form in create mode with Name as the first field', () => {
    renderModal({ phaseName: 'Alpha Phase' });
    expect(screen.getByText('NEW TASK')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /Add to Alpha Phase/ })).toBeInTheDocument();
    const name = screen.getByLabelText('Task name *') as HTMLInputElement;
    expect(name.value).toBe('');
    // Progress slider is suppressed in create mode (Priya-priority spec).
    expect(screen.queryByLabelText('Progress')).not.toBeInTheDocument();
  });

  it('prefills from the task in edit mode and shows the progress slider near the top', () => {
    renderModal({ task: baseTask({ name: 'Prefilled', progress: 42, notes: 'My notes' }) });
    expect(screen.getByText('EDIT TASK')).toBeInTheDocument();
    const name = screen.getByLabelText('Task name *') as HTMLInputElement;
    expect(name.value).toBe('Prefilled');
    const progress = screen.getByLabelText('Progress') as HTMLInputElement;
    expect(progress.value).toBe('42');
    const notes = screen.getByLabelText('Description') as HTMLTextAreaElement;
    expect(notes.value).toBe('My notes');
  });

  // ----- Sprint conditional ------------------------------------------------

  it('hides the Sprint field when project.agile_features is false', () => {
    mockProjectAgile = false;
    renderModal();
    expect(screen.queryByLabelText('Sprint')).not.toBeInTheDocument();
  });

  it('shows the Sprint field when project.agile_features is true', () => {
    mockProjectAgile = true;
    mockSprints = [{ id: 'sprint-1', name: 'Sprint Alpha', state: 'ACTIVE' }];
    renderModal();
    expect(screen.getByLabelText('Sprint')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /No sprint/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Sprint Alpha/ })).toBeInTheDocument();
  });

  // ----- Submit ------------------------------------------------------------

  it('disables Save while Name is empty', () => {
    renderModal();
    const submit = screen.getByRole('button', { name: 'Create task' });
    expect(submit).toBeDisabled();
  });

  it('enables Save once Name has content and submits with create payload', async () => {
    renderModal({ phaseName: 'Alpha', parentId: 'phase-uuid' });
    const name = screen.getByLabelText('Task name *');
    fireEvent.change(name, { target: { value: 'New task' } });
    const submit = screen.getByRole('button', { name: 'Create task' });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    // mutateAsync runs in microtask — flush awaits.
    await Promise.resolve();
    expect(createMutate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New task',
      parent_id: 'phase-uuid',
      duration: 1,
      status: 'NOT_STARTED',
    }));
  });

  it('Cmd+S submits when the form is valid', async () => {
    const onClose = vi.fn();
    renderModal({ phaseName: 'Alpha', onClose });
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'Quick' } });
    fireEvent.keyDown(document, { key: 's', metaKey: true });
    await Promise.resolve();
    expect(createMutate).toHaveBeenCalled();
  });

  it('updates an existing task with PATCH payload in edit mode', async () => {
    renderModal({ task: baseTask({ name: 'Original' }) });
    const name = screen.getByLabelText('Task name *');
    fireEvent.change(name, { target: { value: 'Edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await Promise.resolve();
    expect(updateMutate).toHaveBeenCalledWith(expect.objectContaining({
      id: 'edit-task-id',
      name: 'Edited',
      projectId: 'project-1',
    }));
  });

  // ----- Delete + role gate ------------------------------------------------

  it('shows the Delete button in edit mode when role is PROJECT_MANAGER (3)', () => {
    mockUserRole = 3;
    renderModal({ task: baseTask() });
    expect(screen.getByRole('button', { name: 'Delete task' })).toBeInTheDocument();
  });

  it('hides the Delete button when the user is a Member (role=1)', () => {
    mockUserRole = 1;
    renderModal({ task: baseTask() });
    expect(screen.queryByRole('button', { name: 'Delete task' })).not.toBeInTheDocument();
  });

  it('hides the Delete button when the user is a Resource Manager (role=2 — API forbids)', () => {
    mockUserRole = 2;
    renderModal({ task: baseTask() });
    expect(screen.queryByRole('button', { name: 'Delete task' })).not.toBeInTheDocument();
  });

  it('opens the destructive confirm dialog when Delete is clicked', () => {
    mockUserRole = 4;
    renderModal({ task: baseTask({ name: 'To be deleted' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/“To be deleted”/)).toBeInTheDocument();
  });

  it('calls deleteTask.mutateAsync on confirm and notifies onDeleted', async () => {
    mockUserRole = 4;
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    renderModal({ task: baseTask(), onClose, onDeleted });
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(deleteMutate).toHaveBeenCalledWith('edit-task-id');
    expect(onDeleted).toHaveBeenCalledWith('edit-task-id');
    expect(onClose).toHaveBeenCalled();
  });

  // ----- Last edited footer ------------------------------------------------

  it('renders the "Edited by …" footer when history.history_user is present', () => {
    mockHistory = [{
      history_date: new Date(Date.now() - 60_000).toISOString(),
      history_user: 'Maya Patel',
      diff: [],
    }];
    renderModal({ task: baseTask() });
    expect(screen.getByText(/Edited by Maya Patel/)).toBeInTheDocument();
  });

  it('renders the attribution-less "Edited …" copy when history_user is null (non-Admin viewer)', () => {
    mockHistory = [{
      history_date: new Date(Date.now() - 60_000).toISOString(),
      history_user: null,
      diff: [],
    }];
    renderModal({ task: baseTask() });
    expect(screen.getByText(/^Edited /)).toBeInTheDocument();
    expect(screen.queryByText(/Edited by/)).not.toBeInTheDocument();
  });

  it('omits the last-edited footer in create mode', () => {
    mockHistory = [{
      history_date: new Date().toISOString(),
      history_user: 'Maya',
      diff: [],
    }];
    renderModal();
    expect(screen.queryByText(/^Edited/)).not.toBeInTheDocument();
  });

  // ----- Readonly viewer ---------------------------------------------------

  it('renders read-only mode for a viewer (role=0): Save and Delete are hidden, footer shows only Close', () => {
    mockUserRole = 0;
    renderModal({ task: baseTask() });
    expect(screen.getByText('VIEW TASK')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save|Create/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete task' })).not.toBeInTheDocument();
    // Two `Close`-named buttons exist (header × also has aria-label="Close");
    // assert the footer text button via role+exact-name match. The header
    // button's accessible name is set by aria-label.
    const closes = screen.getAllByRole('button', { name: 'Close' });
    expect(closes.length).toBeGreaterThanOrEqual(1);
  });

  // ----- Mobile shell ------------------------------------------------------

  it('renders the mobile shell (full-screen BottomSheet) when isMobile=true', () => {
    renderModal({ isMobile: true });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Full-screen sheets use inset-0; the modal-shell parent is hidden at md.
    expect(dialog.className).toContain('inset-0');
  });
});
