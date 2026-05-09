/**
 * Tests for DependenciesTab — #249 dep-type label standardisation and
 * per-row cycle error display (ADR-0058).
 */
import { screen, fireEvent, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { DependenciesTab } from './DependenciesTab';
import type { Task, TaskLink } from '@/types';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

type MutateOpts = { onError?: (err: unknown) => void; onSuccess?: () => void };
let capturedUpdateOpts: MutateOpts | null = null;
const updateMutateMock = vi.fn().mockImplementation((_payload: unknown, opts: MutateOpts) => {
  capturedUpdateOpts = opts ?? null;
});

vi.mock('@/hooks/useDependencyMutations', () => ({
  useCreateDependency: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateDependency: () => ({ mutate: updateMutateMock, isPending: false }),
  useDeleteDependency: () => ({ mutate: vi.fn(), isPending: false }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASK_A: Task = {
  id: 'task-a',
  wbs: '1.1',
  name: 'Task A',
  start: '2026-06-01',
  finish: '2026-06-05',
  duration: 4,
  progress: 0,
  parentId: null,
  isCritical: false,
  isComplete: false,
  isSummary: false,
  isMilestone: false,
  status: 'NOT_STARTED',
  assignees: [],
  notes: '',
};

const TASK_B: Task = {
  ...TASK_A,
  id: 'task-b',
  wbs: '1.2',
  name: 'Task B',
  start: '2026-06-06',
  finish: '2026-06-10',
};

const FS_LINK: TaskLink = {
  id: 'link-1',
  sourceId: 'task-a',
  targetId: 'task-b',
  type: 'FS',
  lag: 0,
  isCritical: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderTab(
  taskId = 'task-b',
  links: TaskLink[] = [],
  tasks: Task[] = [TASK_A, TASK_B],
) {
  const task = tasks.find((t) => t.id === taskId) ?? TASK_B;
  return renderWithProviders(
    <DependenciesTab
      task={task}
      tasks={tasks}
      links={links}
      projectId="proj-1"
    />,
  );
}

// ---------------------------------------------------------------------------
// Label constants
// ---------------------------------------------------------------------------

describe('DEP_TYPES labels — #249', () => {
  it('renders Finish → Start as the FS option in AddDepRow', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    // AddDepRow "Add predecessor" select should contain plain-English labels
    const selects = screen.getAllByRole('combobox');
    const predTypeSelect = selects.find((s) =>
      s.querySelector('option[value="FS"]')?.textContent === 'Finish → Start',
    );
    expect(predTypeSelect).toBeDefined();
  });

  it('renders Start → Start as the SS option', () => {
    renderTab();
    const options = screen.getAllByRole('option', { name: 'Start → Start' });
    expect(options.length).toBeGreaterThan(0);
  });

  it('renders Finish → Finish as the FF option', () => {
    renderTab();
    const options = screen.getAllByRole('option', { name: 'Finish → Finish' });
    expect(options.length).toBeGreaterThan(0);
  });

  it('renders Start → Finish as the SF option', () => {
    renderTab();
    const options = screen.getAllByRole('option', { name: 'Start → Finish' });
    expect(options.length).toBeGreaterThan(0);
  });

  it('does not render bare acronym FS as option text', () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);
    // All options with value="FS" should show full label, not bare "FS"
    const fsOptions = screen.queryAllByRole('option', { name: /^FS$/ });
    expect(fsOptions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DepRow — per-row cycle error display
// ---------------------------------------------------------------------------

describe('DepRow per-row error on cycle 400 — #249', () => {
  beforeEach(() => {
    capturedUpdateOpts = null;
    updateMutateMock.mockClear();
  });

  it('shows no row error initially', () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows cycle error alert when onError fires with cycle payload', async () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);

    const depTypeSelect = screen.getByRole('combobox', { name: 'Dependency type' });
    fireEvent.change(depTypeSelect, { target: { value: 'SS' } });

    expect(capturedUpdateOpts).not.toBeNull();
    const cycleError = {
      response: {
        data: {
          detail: 'cyclic_dependency',
          cycle: [
            { id: 'task-a', name: 'Task A', hex_id: 'abc' },
            { id: 'task-b', name: 'Task B', hex_id: 'def' },
            { id: 'task-a', name: 'Task A', hex_id: 'abc' },
          ],
        },
        status: 400,
      },
    };

    await act(async () => {
      capturedUpdateOpts?.onError?.(cycleError);
    });

    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    // Message includes task names from the cycle
    expect(alert.textContent).toMatch(/Task A/);
  });

  it('clears row error when dep type is changed again', async () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);

    const depTypeSelect = screen.getByRole('combobox', { name: 'Dependency type' });
    fireEvent.change(depTypeSelect, { target: { value: 'SS' } });
    await act(async () => {
      capturedUpdateOpts?.onError?.({
        response: {
          data: {
            detail: 'cyclic_dependency',
            cycle: [
              { id: 'task-a', name: 'Task A', hex_id: 'abc' },
              { id: 'task-b', name: 'Task B', hex_id: 'def' },
              { id: 'task-a', name: 'Task A', hex_id: 'abc' },
            ],
          },
          status: 400,
        },
      });
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Change again — error should clear
    fireEvent.change(depTypeSelect, { target: { value: 'FF' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows generic error message when 400 is not a cycle error', async () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);

    const depTypeSelect = screen.getByRole('combobox', { name: 'Dependency type' });
    fireEvent.change(depTypeSelect, { target: { value: 'SS' } });

    await act(async () => {
      capturedUpdateOpts?.onError?.({ response: { data: { detail: 'unknown' }, status: 400 } });
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Try again/i);
  });
});
