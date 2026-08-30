/**
 * TaskFormModal — the dependency editor's role band (#3143).
 *
 * The modal gated its predecessor editor on `isReadOnly`, whose predicate is
 *
 *     isViewer || (mode === 'edit' && role === ROLE_MEMBER &&
 *                  task?.assignees.every(() => false) === true)
 *
 * `every(() => false)` ignores its argument, so it never compares against the
 * current user: vacuously `true` on an empty assignee array and `false` on any
 * non-empty one. A Member on an assigned task therefore got the editor and a
 * 403 on save. It is also the wrong *question* — edges are `IsProjectScheduler`
 * and task content is `IsProjectPlanAuthor`, and neither band contains the
 * other (ADR-0773 §7).
 *
 * These tests drive the role AND the assignee array together, because a test
 * that varied only the role would pass against the broken predicate too.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Task } from '@/types';
import { ROLE_VIEWER, ROLE_MEMBER, ROLE_SCHEDULER, ROLE_ADMIN } from '@/lib/roles';
import { TaskFormModal } from './index';

const roleState = { role: ROLE_SCHEDULER as number | null, isError: false };

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

/**
 * The editor's entry point. **Absent** — not merely disabled — when the reader
 * may not author edges: a dimmed button announces "[label], dimmed" and, for a
 * Member, would be the one greyed control in an otherwise-live form.
 */
function linkButton() {
  return screen.queryByRole('button', { name: /link predecessor/i });
}

/**
 * An assignee array that is NON-empty. This is the input that made the old
 * predicate return `false` (i.e. "not read-only") for a Member — so every
 * refusal case below is driven with it, and a regression to the old predicate
 * fails rather than passing by luck.
 */
const ASSIGNED: Partial<Task> = {
  assignees: [{ resourceId: 'r1', name: 'Alice Ng', units: 100 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  roleState.role = ROLE_SCHEDULER;
  roleState.isError = false;
});

describe('TaskFormModal — dependency editor band (#3143)', () => {
  it.each([
    ['Scheduler', ROLE_SCHEDULER],
    ['Admin', ROLE_ADMIN],
  ])('enables the predecessor editor for a %s', (_l, role) => {
    roleState.role = role;
    renderModal(editTask(ASSIGNED));
    expect(linkButton()).toBeEnabled();
  });

  it('keeps the predecessor chips readable for a refused reader — gated, not hidden', () => {
    roleState.role = ROLE_VIEWER;
    renderModal(editTask(ASSIGNED));
    // No entry point and no per-chip remove…
    expect(linkButton()).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove predecessor/i })).toBeNull();
  });

  it('disables it for a Member on an ASSIGNED task — the case the old predicate let through', () => {
    roleState.role = ROLE_MEMBER;
    renderModal(editTask(ASSIGNED));
    expect(linkButton()).toBeNull();
  });

  it('disables it for a Member on an unassigned task too', () => {
    roleState.role = ROLE_MEMBER;
    renderModal(editTask({ assignees: [] }));
    expect(linkButton()).toBeNull();
  });

  it('disables it for a Viewer', () => {
    roleState.role = ROLE_VIEWER;
    renderModal(editTask(ASSIGNED));
    expect(linkButton()).toBeNull();
  });

  it('enables it when the role read FAILED — unsettled is not denial (#2961)', () => {
    roleState.role = null;
    roleState.isError = true;
    renderModal(editTask(ASSIGNED));
    expect(linkButton()).toBeEnabled();
  });
});
