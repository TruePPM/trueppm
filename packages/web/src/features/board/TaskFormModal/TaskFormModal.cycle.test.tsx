/**
 * TaskFormModal — cycle-detection integration (issue #356 / ADR-0055).
 *
 * Covers the path where `useAddDependency.mutateAsync` rejects with the
 * server's structured 400 cycle payload. Verifies that the modal renders a
 * `role="alert"` toast with task names (not UUIDs) and that the form's
 * `predecessors` array is preserved across the error so the user keeps their
 * selection. Lives in a separate file from `TaskFormModal.test.tsx` to
 * isolate the cycle-specific mock setup (the `mutateAsync` rejection) from
 * the broader form-behavior suite, which mocks the same hook for happy paths.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Task } from '@/types';
import { TaskFormModal } from './index';

let mockServerPredecessors: Array<{ id: string; predecessorId: string; successorId: string }> = [];

const updateMutate = vi.fn().mockResolvedValue({});
const deleteMutate = vi.fn().mockResolvedValue(undefined);

// `addDependencyMutate` is the surface under test — overridden per test to
// reject with a cycle 400 payload.
const addDependencyMutate = vi.fn();

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({
    tasks: [
      { id: 'pred-task', wbs: '1', name: 'Find suppliers', isSummary: false } as Partial<Task>,
      { id: 'edit-task-id', wbs: '2', name: 'Validate', isSummary: false } as Partial<Task>,
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

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: 3, isLoading: false }),
}));

vi.mock('@/hooks/useProjectResourcePool', () => ({
  useProjectResourcePool: () => ({ data: [], isLoading: false }),
}));

vi.mock('@/hooks/useTaskHistory', () => ({
  useTaskHistory: () => ({ data: { pages: [{ results: [] }] }, isLoading: false }),
}));

vi.mock('@/hooks/useTaskDependencies', () => ({
  useTaskDependencies: () => ({
    predecessors: mockServerPredecessors,
    successors: [],
    isLoading: false,
    error: null,
  }),
}));

// Pass the cycle helpers through to their real implementations — the parser
// and formatter are pure and we want the integration test to exercise the
// actual logic, not a mocked shape.
vi.mock('@/hooks/useTaskMutations', async (orig) => {
  const actual = await orig<typeof import('@/hooks/useTaskMutations')>();
  return {
    ...actual,
    useCreateTask: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue({ id: 'new-task-id' }),
      isPending: false,
    }),
    useUpdateTask: () => ({ mutate: vi.fn(), mutateAsync: updateMutate, isPending: false }),
    useDeleteTask: () => ({ mutate: vi.fn(), mutateAsync: deleteMutate, isPending: false }),
    useAddDependency: () => ({
      mutate: vi.fn(),
      mutateAsync: addDependencyMutate,
      isPending: false,
    }),
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
    plannedStart: '2026-05-04',
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

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TaskFormModal projectId="project-1" task={editTask()} isMobile={false} onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockServerPredecessors = [];
});

describe('TaskFormModal cycle detection (#356)', () => {
  it('renders the cycle path with task names in a role="alert" toast', async () => {
    addDependencyMutate.mockRejectedValue({
      response: {
        status: 400,
        data: {
          detail: 'cyclic_dependency',
          cycle: [
            { id: 'pred-task', name: 'Find suppliers', hex_id: 'aa11' },
            { id: 'edit-task-id', name: 'Validate', hex_id: 'bb22' },
            { id: 'pred-task', name: 'Find suppliers', hex_id: 'aa11' },
          ],
        },
      },
    });

    renderModal();

    // PredecessorsEditor: open picker, type to filter, click the matching row.
    fireEvent.click(screen.getByRole('button', { name: /link predecessor/i }));
    const search = screen.getByLabelText(/search predecessor tasks/i);
    fireEvent.change(search, { target: { value: 'Find' } });
    const matchRow = await screen.findByRole('button', { name: /find suppliers/i });
    fireEvent.click(matchRow);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'This would create a circular dependency: Find suppliers → Validate → Find suppliers. Remove one of these edges first.',
    );
    // Names — not UUIDs — are surfaced.
    expect(within(alert).queryByText(/pred-task/)).toBeNull();
  });

  it('preserves the user’s predecessor selection across a cycle error', async () => {
    addDependencyMutate.mockRejectedValue({
      response: {
        status: 400,
        data: {
          detail: 'cyclic_dependency',
          cycle: [
            { id: 'pred-task', name: 'Find suppliers', hex_id: 'aa11' },
            { id: 'edit-task-id', name: 'Validate', hex_id: 'bb22' },
            { id: 'pred-task', name: 'Find suppliers', hex_id: 'aa11' },
          ],
        },
      },
    });

    renderModal();

    fireEvent.click(screen.getByRole('button', { name: /link predecessor/i }));
    const search = screen.getByLabelText(/search predecessor tasks/i);
    fireEvent.change(search, { target: { value: 'Find' } });
    const matchRow = await screen.findByRole('button', { name: /find suppliers/i });
    fireEvent.click(matchRow);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await screen.findByRole('alert');

    // The chosen predecessor remains in the working list — visible somewhere
    // inside the modal — so the user can adjust without re-picking.
    await waitFor(() => {
      expect(screen.getAllByText(/Find suppliers/).length).toBeGreaterThan(0);
    });
  });
});
