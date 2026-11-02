/**
 * TaskFormModal — which fields are editable, and who decides.
 *
 * The modal used to derive read-only from `assignees.every(() => false)`, which
 * ignores its argument: true on an empty array, false on any non-empty one, so a
 * Member on someone else's task got a live form and a 403 on save. It now asks
 * `canEditTaskRow`, the resolver the schedule outline and canvas use, so the
 * server's per-task verdict decides and the role only backs it up when absent.
 *
 * Each Member row varies the server verdict together with the assignee array,
 * because a test that varied only one of them passes on the old predicate too.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Task } from '@/types';
import { ROLE_VIEWER, ROLE_MEMBER, ROLE_ADMIN, canEditTaskRow } from '@/lib/roles';
import { TaskFormModal } from './index';

const roleState = { role: ROLE_MEMBER as number | null, isError: false };

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({
    role: roleState.role,
    isLoading: false,
    isError: roleState.isError,
  }),
}));

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({
    tasks: [
      { id: 'pred-task', wbs: '1', name: 'Find suppliers', isSummary: false },
      { id: 'edit-task-id', wbs: '2', name: 'Validate', isSummary: false },
    ] as Task[],
    links: [],
    isLoading: false,
    error: null,
  }),
}));
vi.mock('@/hooks/useSprints', () => ({
  useSprints: () => ({ sprints: [], isLoading: false, error: null }),
}));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({ data: { agile_features: false }, isLoading: false }),
}));
vi.mock('@/hooks/useProjectResourcePool', () => ({
  useProjectResourcePool: () => ({ data: [], isLoading: false }),
}));
vi.mock('@/hooks/useTaskHistory', () => ({
  useTaskHistory: () => ({ data: { pages: [{ results: [] }] }, isLoading: false }),
}));
vi.mock('@/hooks/useTaskDependencies', () => ({
  useTaskDependencies: () => ({
    predecessors: [],
    successors: [],
    isLoading: false,
    error: null,
  }),
}));
vi.mock('@/hooks/useTaskMutations', async (orig) => {
  const actual = await orig<typeof import('@/hooks/useTaskMutations')>();
  return {
    ...actual,
    useCreateTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useUpdateTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useDeleteTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useAddDependency: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useRemoveDependency: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  };
});
vi.mock('@/hooks/useAssignmentMutations', () => ({
  useAddAssignment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useUpdateAssignment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRemoveAssignment: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

function editTask(over: Partial<Task> = {}): Task {
  return {
    id: 'edit-task-id',
    wbs: '2',
    name: 'Validate',
    start: '2026-05-04',
    finish: '2026-05-08',
    duration: 5,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    ...over,
  };
}

function renderModal(task: Task) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TaskFormModal projectId="project-1" task={task} isMobile={false} onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}


beforeEach(() => {
  vi.clearAllMocks();
  roleState.role = ROLE_MEMBER;
  roleState.isError = false;
});

const nameField = () => screen.getByRole('textbox', { name: /^task name/i });

describe('TaskFormModal — read-only resolves the server verdict (edit mode)', () => {
  const OTHER = { assignees: [{ resourceId: 'r2', name: 'Bob Roy', units: 100 }] };
  const SELF = { assignees: [{ resourceId: 'r1', name: 'Alice Ng', units: 100 }] };

  it.each([
    ['unassigned task', { assignees: [], canEdit: false }, true],
    ["someone else's task", { ...OTHER, canEdit: false }, true],
    ['their own task', { ...SELF, canEdit: true }, false],
  ])('Member on %s: read-only=%s follows task.canEdit', (_l, over, readOnly) => {
    roleState.role = ROLE_MEMBER;
    renderModal(editTask(over));
    if (readOnly) expect(nameField()).toBeDisabled();
    else expect(nameField()).toBeEnabled();
    expect(screen.queryByText('VIEW TASK') !== null).toBe(readOnly);
  });

  it('lets the server verdict outrank the role in both directions', () => {
    roleState.role = ROLE_ADMIN;
    const { unmount } = renderModal(editTask({ canEdit: false }));
    expect(nameField()).toBeDisabled();
    unmount();
    roleState.role = ROLE_VIEWER;
    renderModal(editTask({ canEdit: true }));
    expect(nameField()).toBeEnabled();
  });

  it('falls back to the role only when the server sent no verdict', () => {
    roleState.role = ROLE_VIEWER;
    const { unmount } = renderModal(editTask({ ...OTHER }));
    expect(nameField()).toBeDisabled();
    unmount();
    roleState.role = ROLE_MEMBER;
    renderModal(editTask({ ...OTHER }));
    expect(nameField()).toBeEnabled();
  });

  it('keeps the form editable while the role is unsettled and no verdict exists', () => {
    roleState.role = null;
    roleState.isError = true;
    renderModal(editTask({}));
    expect(nameField()).toBeEnabled();
  });

  it.each([
    [true, ROLE_MEMBER],
    [false, ROLE_MEMBER],
    [undefined, ROLE_MEMBER],
    [undefined, ROLE_VIEWER],
    [undefined, ROLE_ADMIN],
    [undefined, null],
    [true, null],
    [false, null],
  ])('agrees with canEditTaskRow for canEdit=%s role=%s', (canEdit, role) => {
    roleState.role = role;
    renderModal(editTask({ canEdit }));
    expect(!nameField().hasAttribute('disabled')).toBe(canEditTaskRow(canEdit, role, false));
  });
});
