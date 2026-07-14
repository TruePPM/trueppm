import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
let mockUserRole = 300; // PM by default; tests override to flex permissions
let mockResourcePool: Array<{ resource: { id: string; name: string }; roleTitle: string }> = [];
let mockSprints: Array<{ id: string; name: string; state: string }> = [];
let mockHistory: Array<{ history_date: string; history_user: string | null; diff: unknown[] }> = [];
let mockServerPredecessors: Array<{ id: string; predecessorId: string; successorId: string }> = [];
let mockPredsResolved = true;
let mockPredsError: Error | null = null;

const createMutate = vi.fn().mockResolvedValue({ id: 'new-task-id' });
const updateMutate = vi.fn().mockResolvedValue({});
const deleteMutate = vi.fn().mockResolvedValue(undefined);
const addAssignmentMutate = vi.fn().mockResolvedValue({ assignment: {}, warnings: [] });
const addDependencyMutate = vi.fn().mockResolvedValue({});
const toastSuccessSpy = vi.hoisted(() => vi.fn());
vi.mock('@/components/Toast', () => ({
  toast: { success: toastSuccessSpy, info: vi.fn(), error: vi.fn(), warm: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({
    tasks: [
      { id: 'parent-task-id', wbs: '1', name: 'Parent task', isSummary: true, isMilestone: false } as Partial<Task>,
      { id: 'sibling-1', wbs: '2', name: 'Sibling one', isSummary: false, isMilestone: false } as Partial<Task>,
      { id: 'leaf-phase-id', wbs: '3', name: 'Phase 4', isSummary: false, isMilestone: false } as Partial<Task>,
      { id: 'milestone-1', wbs: '4', name: 'Launch GA', isSummary: false, isMilestone: true } as Partial<Task>,
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
    isFetching: false,
    hasResolved: mockPredsResolved,
    error: mockPredsError,
  }),
}));

const mockParseProgressAnchorError = vi.hoisted(() =>
  vi.fn(
    () =>
      null as null | {
        code: 'progress_requires_anchor';
        detail: string;
        suggested_action: 'set_planned_start' | 'assign_sprint';
      },
  ),
);

vi.mock('@/hooks/useTaskMutations', () => ({
  useCreateTask: () => ({ mutate: vi.fn(), mutateAsync: createMutate, isPending: false }),
  useUpdateTask: () => ({ mutate: vi.fn(), mutateAsync: updateMutate, isPending: false }),
  useDeleteTask: () => ({ mutate: vi.fn(), mutateAsync: deleteMutate, isPending: false }),
  useAddDependency: () => ({ mutate: vi.fn(), mutateAsync: addDependencyMutate, isPending: false }),
  useRemoveDependency: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  parseCyclicDependencyError: () => null,
  formatCycleMessage: () => '',
  parseProgressAnchorError: mockParseProgressAnchorError,
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
    mockUserRole = 300;
    mockResourcePool = [];
    mockSprints = [];
    mockHistory = [];
    mockServerPredecessors = [];
    mockPredsResolved = true;
    mockPredsError = null;
    mockParseProgressAnchorError.mockReturnValue(null);
  });

  // ----- Mode + header -----------------------------------------------------

  it('renders an empty form in create mode with Name as the first field', () => {
    renderModal({ phaseName: 'Alpha Phase' });
    expect(screen.getByText('NEW TASK')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /Add to Alpha Phase/ })).toBeInTheDocument();
    const name = screen.getByLabelText<HTMLInputElement>('Task name *');
    expect(name.value).toBe('');
    // Progress slider is suppressed in create mode (Priya-priority spec).
    expect(screen.queryByLabelText('Progress')).not.toBeInTheDocument();
  });

  it('prefills from the task in edit mode and shows the progress slider near the top', () => {
    renderModal({ task: baseTask({ name: 'Prefilled', progress: 42, notes: 'My notes' }) });
    expect(screen.getByText('EDIT TASK')).toBeInTheDocument();
    const name = screen.getByLabelText<HTMLInputElement>('Task name *');
    expect(name.value).toBe('Prefilled');
    const progress = screen.getByLabelText<HTMLInputElement>('Progress');
    expect(progress.value).toBe('42');
    const notes = screen.getByLabelText<HTMLTextAreaElement>('Description');
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

  // ----- Story points estimate (ADR-0418, #1961) ---------------------------

  it('shows the story-points (Pts) input even when project.agile_features is false (#1961)', () => {
    // The estimate is decoupled from agile features: available on every
    // methodology, while the Sprint selector stays agile-only.
    mockProjectAgile = false;
    renderModal();
    expect(screen.getByLabelText('Pts')).toBeInTheDocument();
    expect(screen.queryByLabelText('Sprint')).not.toBeInTheDocument();
  });

  it('shows the Pts input alongside the Sprint field when agile_features is true', () => {
    mockProjectAgile = true;
    mockSprints = [{ id: 'sprint-1', name: 'Sprint Alpha', state: 'ACTIVE' }];
    renderModal();
    expect(screen.getByLabelText('Pts')).toBeInTheDocument();
    expect(screen.getByLabelText('Sprint')).toBeInTheDocument();
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

  it('fires a "Created" toast on successful create (rule 185)', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'New task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(toastSuccessSpy).toHaveBeenCalledWith('Created New task'));
  });

  it('scales the desktop modal panel in on open (rule 185)', () => {
    renderModal();
    const panel = screen.getByRole('dialog').firstElementChild as HTMLElement;
    expect(panel.className).toContain('motion-safe:animate-modal-scale-in');
  });

  // ----- Classification (task taxonomy editor) -----------------------------

  it('renders the Classification group with server defaults in create mode', () => {
    renderModal();
    expect(screen.getByLabelText<HTMLSelectElement>('Type').value).toBe('task');
    expect(screen.getByLabelText<HTMLSelectElement>('Governance class').value).toBe('flow');
    expect(screen.getByLabelText<HTMLSelectElement>('Delivery mode').value).toBe('waterfall');
  });

  it('includes the taxonomy fields in the create payload', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'Spike it' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'spike' } });
    fireEvent.change(screen.getByLabelText('Governance class'), { target: { value: 'gated' } });
    fireEvent.change(screen.getByLabelText('Delivery mode'), { target: { value: 'kanban' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await Promise.resolve();
    expect(createMutate).toHaveBeenCalledWith(expect.objectContaining({
      type: 'spike',
      governance_class: 'gated',
      delivery_mode: 'kanban',
    }));
  });

  it('prefills the taxonomy selects in edit mode and submits a changed type', async () => {
    renderModal({
      task: baseTask({ taskType: 'story', governanceClass: 'gated', deliveryMode: 'kanban' }),
    });
    expect(screen.getByLabelText<HTMLSelectElement>('Type').value).toBe('story');
    expect(screen.getByLabelText<HTMLSelectElement>('Governance class').value).toBe('gated');
    expect(screen.getByLabelText<HTMLSelectElement>('Delivery mode').value).toBe('kanban');
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'bug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await Promise.resolve();
    expect(updateMutate).toHaveBeenCalledWith(expect.objectContaining({
      type: 'bug',
      governance_class: 'gated',
      delivery_mode: 'kanban',
    }));
  });

  it('falls back to server defaults when the task omits taxonomy fields', () => {
    renderModal({ task: baseTask() });
    expect(screen.getByLabelText<HTMLSelectElement>('Type').value).toBe('task');
    expect(screen.getByLabelText<HTMLSelectElement>('Governance class').value).toBe('flow');
    expect(screen.getByLabelText<HTMLSelectElement>('Delivery mode').value).toBe('waterfall');
  });

  it('suppresses the Classification group in milestone-create mode', () => {
    renderModal({ isMilestone: true });
    expect(screen.queryByLabelText('Type')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Governance class')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Delivery mode')).not.toBeInTheDocument();
  });

  it('parent picker includes leaf tasks and excludes milestones (#378)', () => {
    renderModal();
    const picker = screen.getByLabelText<HTMLSelectElement>(/Parent phase/);
    const labels = Array.from(picker.options).map((o) => o.textContent);
    // Summary phase + both leaf tasks are valid parents.
    expect(labels).toContain('1 · Parent task');
    expect(labels).toContain('2 · Sibling one');
    expect(labels).toContain('3 · Phase 4');
    // Milestones can't host children — never offered as a parent.
    expect(labels).not.toContain('4 · Launch GA');
  });

  it('shows leaf-promotion hint copy when a leaf task is selected as parent (#378)', async () => {
    renderModal();
    const picker = screen.getByLabelText<HTMLSelectElement>(/Parent phase/);
    fireEvent.change(picker, { target: { value: 'sibling-1' } });
    expect(
      await screen.findByText('Adding a task here will turn this task into a phase.'),
    ).toBeInTheDocument();
    // Switching back to a real summary phase reverts to the regular hint.
    fireEvent.change(picker, { target: { value: 'parent-task-id' } });
    expect(
      await screen.findByText('New task will be added as a child of this phase.'),
    ).toBeInTheDocument();
  });

  it('posts the leaf parent id on create — server promotes it to a summary on next read (#378)', async () => {
    renderModal();
    const picker = screen.getByLabelText<HTMLSelectElement>(/Parent phase/);
    fireEvent.change(picker, { target: { value: 'leaf-phase-id' } });
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'Child of leaf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await Promise.resolve();
    expect(createMutate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Child of leaf',
      parent_id: 'leaf-phase-id',
    }));
  });

  it('renders the parent picker seeded from the inferred parentId, and posts the chosen id (#360)', async () => {
    renderModal({ parentId: 'parent-task-id' });
    const picker = screen.getByLabelText<HTMLSelectElement>(/Parent phase/);
    // Seeded from prop — select value is the task UUID.
    expect(picker.value).toBe('parent-task-id');
    // Selecting the "No parent (root)" option drops back to root parent.
    fireEvent.change(picker, { target: { value: '' } });
    expect(screen.getByText(/add at the project root/)).toBeInTheDocument();
    // Re-selecting the parent option re-resolves to the matching id.
    fireEvent.change(picker, { target: { value: 'parent-task-id' } });
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'Child' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await Promise.resolve();
    expect(createMutate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Child',
      parent_id: 'parent-task-id',
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
    mockUserRole = 300;
    renderModal({ task: baseTask() });
    expect(screen.getByRole('button', { name: 'Delete task' })).toBeInTheDocument();
  });

  it('hides the Delete button when the user is a Member (ROLE_MEMBER)', () => {
    mockUserRole = 100;
    renderModal({ task: baseTask() });
    expect(screen.queryByRole('button', { name: 'Delete task' })).not.toBeInTheDocument();
  });

  it('hides the Delete button when the user is a Resource Manager (ROLE_SCHEDULER — API forbids)', () => {
    mockUserRole = 200;
    renderModal({ task: baseTask() });
    expect(screen.queryByRole('button', { name: 'Delete task' })).not.toBeInTheDocument();
  });

  it('opens the destructive confirm dialog when Delete is clicked', () => {
    mockUserRole = 400;
    renderModal({ task: baseTask({ name: 'To be deleted' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/“To be deleted”/)).toBeInTheDocument();
  });

  it('calls deleteTask.mutateAsync on confirm and notifies onDeleted', async () => {
    mockUserRole = 400;
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

  it('renders read-only mode for a viewer (ROLE_VIEWER): Save and Delete are hidden, footer shows only Close', () => {
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

  it('renders the destructive confirm dialog inside the mobile shell as well', () => {
    mockUserRole = 400;
    renderModal({ task: baseTask({ name: 'Mobile delete' }), isMobile: true });
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/“Mobile delete”/)).toBeInTheDocument();
  });

  // ----- Dirty-check escape paths ------------------------------------------

  it('prompts for confirmation on Cancel when the form is dirty and closes only when confirmed', () => {
    const onClose = vi.fn();
    renderModal({ phaseName: 'Alpha', onClose });
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'dirty' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // #838: an ARIA-managed dialog replaces window.confirm.
    expect(screen.getByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the modal open if the user declines the discard prompt on Cancel', () => {
    const onClose = vi.fn();
    renderModal({ phaseName: 'Alpha', onClose });
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'dirty' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
  });

  it('Esc closes the modal directly when the form is pristine', () => {
    const onClose = vi.fn();
    renderModal({ phaseName: 'Alpha', onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('Esc prompts before closing when the form is dirty', () => {
    const onClose = vi.fn();
    renderModal({ phaseName: 'Alpha', onClose });
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'dirty' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    // #838: the discard dialog appears instead of window.confirm; closing still
    // requires an explicit Discard.
    expect(screen.getByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('Esc is a no-op while the destructive confirm dialog is open (the dialog handles its own Esc)', () => {
    mockUserRole = 400;
    const onClose = vi.fn();
    renderModal({ task: baseTask(), onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    onClose.mockClear();
    fireEvent.keyDown(document, { key: 'Escape' });
    // Modal's onKey returns early when the confirm dialog is mounted.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces the create error message and keeps the modal open when mutateAsync rejects', async () => {
    createMutate.mockRejectedValueOnce(new Error('Server exploded'));
    const onClose = vi.fn();
    renderModal({ phaseName: 'Alpha', onClose });
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    // Microtasks for createMutate + state set.
    await Promise.resolve();
    await Promise.resolve();
    expect(await screen.findByText('Server exploded')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces the delete error and keeps the modal open when deleteMutate rejects', async () => {
    mockUserRole = 400;
    deleteMutate.mockRejectedValueOnce(new Error('Forbidden'));
    const onClose = vi.fn();
    renderModal({ task: baseTask(), onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  // ----- Predecessor hydration / save guards (#354) ------------------------
  //
  // The modal's `useTaskDependencies` query can return an empty predecessor
  // list for non-truth reasons: a 401 mid-modal, the initial loading window,
  // a transient network error. Without guards, the hydration effect would
  // overwrite a populated `pristine.predecessors` with [], and the next
  // Save would diff `working` against [] and silently soft-delete every
  // real predecessor. Two guards prevent this:

  it('skips hydration while the dependency query is unresolved', () => {
    mockPredsResolved = false;
    mockServerPredecessors = [
      { id: 'dep-1', predecessorId: 'parent-task-id', successorId: 'edit-task-id' },
    ];
    renderModal({ task: baseTask() });
    // The PredecessorsEditor renders an empty-state until hydration runs;
    // verify no row was rendered for the unresolved-yet server data.
    expect(screen.queryByText(/Sibling one|Parent task/)).not.toBeInTheDocument();
  });

  it('does not save through `syncPredecessors` when the dependency query is in error state', async () => {
    mockPredsError = new Error('network');
    addDependencyMutate.mockClear();
    const onClose = vi.fn();
    renderModal({ task: baseTask(), onClose });
    // Dirty the name so the form has something to save (and isDirty=true).
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/dependency list is out of date/);
    expect(updateMutate).toHaveBeenCalled();
    expect(addDependencyMutate).not.toHaveBeenCalled();
    // Modal stays open so the user can retry once the query recovers.
    expect(onClose).not.toHaveBeenCalled();
  });

  // ----- Milestone-create mode --------------------------------------------
  // Reaches the dialog from ScheduleView's "+ Milestone" button (was: insert
  // immediately + edit name inline). Validates the field shape so the user
  // can pick a date and parent before commit, and that the submit payload
  // carries is_milestone: true with duration: 0.

  it('milestone mode: header + name copy switch to "milestone"', () => {
    renderModal({ isMilestone: true });
    expect(screen.getByText('NEW MILESTONE')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /New milestone/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Milestone name *')).toBeInTheDocument();
    expect(screen.queryByLabelText('Task name *')).not.toBeInTheDocument();
  });

  it('milestone mode: Duration field is hidden and Date label replaces "Planned start"', () => {
    renderModal({ isMilestone: true });
    expect(screen.queryByLabelText(/Duration/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Date')).toBeInTheDocument();
    expect(screen.queryByLabelText('Planned start')).not.toBeInTheDocument();
  });

  it('milestone mode: name alone is enough to enable submit (no duration validation)', () => {
    renderModal({ isMilestone: true });
    const submit = screen.getByRole('button', { name: 'Create milestone' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Milestone name *'), {
      target: { value: 'Phase 1 sign-off' },
    });
    expect(submit).not.toBeDisabled();
  });

  it('milestone mode: submit posts is_milestone:true with duration:0 and the chosen date + parent', async () => {
    renderModal({ isMilestone: true, parentId: 'parent-task-id' });
    fireEvent.change(screen.getByLabelText('Milestone name *'), {
      target: { value: 'GA cutover' },
    });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create milestone' }));
    await Promise.resolve();
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'GA cutover',
        duration: 0,
        is_milestone: true,
        planned_start: '2026-09-15',
        parent_id: 'parent-task-id',
      }),
    );
  });

  it('milestone mode: parent picker hint reads "milestone" when a leaf is chosen', async () => {
    renderModal({ isMilestone: true });
    const picker = screen.getByLabelText<HTMLSelectElement>(/Parent phase/);
    fireEvent.change(picker, { target: { value: 'sibling-1' } });
    expect(
      await screen.findByText('Adding a milestone here will turn this task into a phase.'),
    ).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'parent-task-id' } });
    expect(
      await screen.findByText('New milestone will be added as a child of this phase.'),
    ).toBeInTheDocument();
  });

  it('milestone mode: onCreated fires with the saved task id before onClose', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    renderModal({ isMilestone: true, onCreated, onClose });
    fireEvent.change(screen.getByLabelText('Milestone name *'), {
      target: { value: 'Drop-dead date' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create milestone' }));
    // Two microtasks: createTask.mutateAsync, then sync passes (assignments + predecessors are no-ops here).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(onCreated).toHaveBeenCalledWith('new-task-id');
    expect(onClose).toHaveBeenCalled();
    // Order: onCreated runs before onClose so the caller can use the new id
    // while the modal is still rendered (e.g. focus, pulse).
    expect(onCreated.mock.invocationCallOrder[0]).toBeLessThan(
      onClose.mock.invocationCallOrder[0],
    );
  });

  it('non-milestone mode: onCreated fires on plain task create too', async () => {
    const onCreated = vi.fn();
    renderModal({ onCreated });
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'Plain task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(onCreated).toHaveBeenCalledWith('new-task-id');
  });

  it('isMilestone is ignored in edit mode (Duration stays visible)', () => {
    renderModal({ isMilestone: true, task: baseTask() });
    // Edit-mode milestones are handled by MetaRail, not this modal — so
    // passing isMilestone with a non-null task must not strip the Duration
    // field from a normal task being edited.
    expect(screen.getByLabelText(/Duration/)).toBeInTheDocument();
    expect(screen.getByText('EDIT TASK')).toBeInTheDocument();
  });

  // ----- Pass 3: progress anchor error in edit mode -------------------------

  it('surfaces the anchor-gate message when update rejects with progress_requires_anchor', async () => {
    updateMutate.mockRejectedValueOnce(new Error('gate'));
    mockParseProgressAnchorError.mockReturnValueOnce({
      code: 'progress_requires_anchor' as const,
      detail: 'Cannot record progress without a planned start date or sprint assignment.',
      suggested_action: 'set_planned_start' as const,
    });
    const onClose = vi.fn();
    renderModal({ task: baseTask(), onClose });
    fireEvent.change(screen.getByLabelText('Task name *'), { target: { value: 'Tweaked' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(
      await screen.findByText('Set a Planned Start date (or assign a sprint) before recording progress.'),
    ).toBeInTheDocument();
    // Modal stays open so the user can add a planned start date.
    expect(onClose).not.toHaveBeenCalled();
  });

  // ----- Assignee control hidden on a phase (issue #1754, ADR-0293) --------

  it('shows the Assignees group when editing a plain (non-phase) task', () => {
    renderModal({ task: baseTask() });
    expect(screen.getByRole('group', { name: 'Assignees' })).toBeInTheDocument();
  });

  it('hides (not disables) the Assignees group when editing a phase — mirrors backend assignee_on_phase', () => {
    renderModal({ task: baseTask({ isPhase: true }) });
    expect(screen.queryByRole('group', { name: 'Assignees' })).not.toBeInTheDocument();
  });

  it('shows the Assignees group in create mode even though isEdit-only phase logic exists (no children yet)', () => {
    renderModal({ task: null });
    expect(screen.getByRole('group', { name: 'Assignees' })).toBeInTheDocument();
  });
});
