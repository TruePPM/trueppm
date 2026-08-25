/**
 * Tests for DependenciesTab — #249 dep-type label standardisation and
 * per-row cycle error display (ADR-0058).
 */
import { screen, fireEvent, act, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { DependenciesTab } from './DependenciesTab';
import type {
  CreateDependencyPayload,
  UpdateDependencyPayload,
} from '@/hooks/useDependencyMutations';
import type { Task, TaskLink } from '@/types';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

type MutateOpts = { onError?: (err: unknown) => void; onSuccess?: () => void };

/** Mutable knobs the mocked hooks read at render time. */
const depHookState = { createPending: false };

let capturedUpdateOpts: MutateOpts | null = null;
let capturedUpdatePayload: UpdateDependencyPayload | null = null;
const updateMutateMock = vi.fn<(payload: UpdateDependencyPayload, opts?: MutateOpts) => void>(
  (payload, opts) => {
    capturedUpdatePayload = payload;
    capturedUpdateOpts = opts ?? null;
  },
);

let capturedCreateOpts: MutateOpts | null = null;
let capturedCreatePayload: CreateDependencyPayload | null = null;
const createMutateMock = vi.fn<(payload: CreateDependencyPayload, opts?: MutateOpts) => void>(
  (payload, opts) => {
    capturedCreatePayload = payload;
    capturedCreateOpts = opts ?? null;
  },
);

const deleteMutateMock = vi.fn<(id: string) => void>();

vi.mock('@/hooks/useDependencyMutations', () => ({
  useCreateDependency: () => ({
    mutate: createMutateMock,
    isPending: depHookState.createPending,
  }),
  useUpdateDependency: () => ({ mutate: updateMutateMock, isPending: false }),
  useDeleteDependency: () => ({ mutate: deleteMutateMock, isPending: false }),
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

const TASK_C: Task = {
  ...TASK_A,
  id: 'task-c',
  wbs: '1.3',
  name: 'Task C',
};

/** A task with no WBS code — exercises the bare-name label fallback in DepRow. */
const TASK_NO_WBS: Task = {
  ...TASK_A,
  id: 'task-d',
  wbs: '',
  name: 'Task D',
};

const FS_LINK: TaskLink = {
  id: 'link-1',
  sourceId: 'task-a',
  targetId: 'task-b',
  type: 'FS',
  lag: 0,
  isCritical: false,
};

function link(overrides: Partial<TaskLink> & Pick<TaskLink, 'id' | 'sourceId' | 'targetId'>): TaskLink {
  return { type: 'FS', lag: 0, isCritical: false, ...overrides };
}

/** A 400 whose payload the cycle parser recognises. */
const CYCLE_ERROR = {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderTab(
  taskId = 'task-b',
  links: TaskLink[] = [],
  tasks: Task[] = [TASK_A, TASK_B],
  programId: string | null = null,
) {
  const task = tasks.find((t) => t.id === taskId) ?? TASK_B;
  return renderWithProviders(
    <DependenciesTab
      task={task}
      tasks={tasks}
      links={links}
      projectId="proj-1"
      programId={programId}
    />,
  );
}

function predSection() {
  return screen.getByRole('region', { name: 'Predecessors' });
}
function succSection() {
  return screen.getByRole('region', { name: 'Successors' });
}

beforeEach(() => {
  depHookState.createPending = false;
  capturedUpdateOpts = null;
  capturedUpdatePayload = null;
  capturedCreateOpts = null;
  capturedCreatePayload = null;
  createMutateMock.mockClear();
  updateMutateMock.mockClear();
  deleteMutateMock.mockClear();
});

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

  it('shows cycle error alert when onError fires with cycle payload', () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);

    const depTypeSelect = screen.getByRole('combobox', { name: 'Dependency type for 1.1 — Task A' });
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

    act(() => {
      capturedUpdateOpts?.onError?.(cycleError);
    });

    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    // Message includes task names from the cycle
    expect(alert.textContent).toMatch(/Task A/);
  });

  it('clears row error when dep type is changed again', () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);

    const depTypeSelect = screen.getByRole('combobox', { name: 'Dependency type for 1.1 — Task A' });
    fireEvent.change(depTypeSelect, { target: { value: 'SS' } });
    act(() => {
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

  it('shows generic error message when 400 is not a cycle error', () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);

    const depTypeSelect = screen.getByRole('combobox', { name: 'Dependency type for 1.1 — Task A' });
    fireEvent.change(depTypeSelect, { target: { value: 'SS' } });

    act(() => {
      capturedUpdateOpts?.onError?.({ response: { data: { detail: 'unknown' }, status: 400 } });
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Try again/i);
  });
});

// ---------------------------------------------------------------------------
// Cross-project search link (ADR-0120) — the inline dropdowns only ever list
// this project's tasks, so a program task is reachable only through the
// ScheduleDependencyPicker modal opened by this link.
// ---------------------------------------------------------------------------

describe('cross-project search link', () => {
  it('is absent for a standalone project (no programId)', () => {
    renderTab('task-b', [], [TASK_A, TASK_B], null);
    expect(
      screen.queryByRole('button', { name: /Search another project in this program/ }),
    ).not.toBeInTheDocument();
  });

  it('renders once per section when the project belongs to a program', () => {
    renderTab('task-b', [], [TASK_A, TASK_B], 'prog-1');
    expect(
      screen.getAllByRole('button', { name: /Search another project in this program/ }),
    ).toHaveLength(2);
  });

  it('opens the ScheduleDependencyPicker landed on Program scope', () => {
    renderTab('task-b', [], [TASK_A, TASK_B], 'prog-1');
    const [predLink] = screen.getAllByRole('button', {
      name: /Search another project in this program/,
    });
    fireEvent.click(predLink);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Program', selected: true })).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('Search tasks in this program…'),
    ).toBeInTheDocument();
  });

  it('closes the picker and returns to the inline dropdowns', () => {
    renderTab('task-b', [], [TASK_A, TASK_B], 'prog-1');
    const [predLink] = screen.getAllByRole('button', {
      name: /Search another project in this program/,
    });
    fireEvent.click(predLink);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the picker in successor mode from the Successors section', () => {
    renderTab('task-b', [], [TASK_A, TASK_B], 'prog-1');
    const succLink = within(succSection()).getByRole('button', {
      name: /Search another project in this program/,
    });
    fireEvent.click(succLink);

    expect(
      screen.getByRole('dialog', { name: 'Add successor to “Task B”' }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Existing link rows
// ---------------------------------------------------------------------------

describe('dependency rows', () => {
  it('shows the "None" placeholder in both sections when the task has no links', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    expect(within(predSection()).getByText('None')).toBeInTheDocument();
    expect(within(succSection()).getByText('None')).toBeInTheDocument();
  });

  it('lists a predecessor row labelled "<wbs> — <name>"', () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);
    expect(within(predSection()).getByTitle('1.1 — Task A')).toBeInTheDocument();
    expect(within(predSection()).queryByText('None')).not.toBeInTheDocument();
    // The link is inbound only — the Successors section is still empty.
    expect(within(succSection()).getByText('None')).toBeInTheDocument();
  });

  it('lists a successor row when the task is the link source', () => {
    renderTab('task-a', [FS_LINK], [TASK_A, TASK_B]);
    expect(within(succSection()).getByTitle('1.2 — Task B')).toBeInTheDocument();
    expect(within(predSection()).getByText('None')).toBeInTheDocument();
  });

  it('falls back to the bare task name when the related task has no WBS', () => {
    renderTab(
      'task-b',
      [link({ id: 'link-d', sourceId: 'task-d', targetId: 'task-b' })],
      [TASK_B, TASK_NO_WBS],
    );
    expect(within(predSection()).getByTitle('Task D')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove dependency on Task D' }),
    ).toBeInTheDocument();
  });

  it('skips a predecessor link whose source task is not in the task list', () => {
    renderTab(
      'task-b',
      [link({ id: 'link-x', sourceId: 'not-loaded', targetId: 'task-b' })],
      [TASK_A, TASK_B],
    );
    expect(
      within(predSection()).queryByRole('combobox', { name: /^Dependency type for (?!new )/ }),
    ).not.toBeInTheDocument();
    // The link exists, so the empty-state placeholder is still suppressed.
    expect(within(predSection()).queryByText('None')).not.toBeInTheDocument();
  });

  it('skips a successor link whose target task is not in the task list', () => {
    renderTab(
      'task-a',
      [link({ id: 'link-y', sourceId: 'task-a', targetId: 'not-loaded' })],
      [TASK_A, TASK_B],
    );
    expect(
      within(succSection()).queryByRole('combobox', { name: /^Dependency type for (?!new )/ }),
    ).not.toBeInTheDocument();
    expect(within(succSection()).queryByText('None')).not.toBeInTheDocument();
  });

  it('deletes the link when the row remove button is pressed', () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove dependency on Task A' }));
    expect(deleteMutateMock).toHaveBeenCalledWith('link-1');
  });
});

// ---------------------------------------------------------------------------
// DepRow — lag field
// ---------------------------------------------------------------------------

describe('DepRow lag field', () => {
  it('patches the lag when a new value is committed on blur', () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);
    const lag = screen.getByRole('spinbutton', { name: 'Lag days for 1.1 — Task A' });
    fireEvent.blur(lag, { target: { value: '5' } });

    expect(updateMutateMock).toHaveBeenCalledTimes(1);
    expect(capturedUpdatePayload).toEqual({ id: 'link-1', lag: 5 });
  });

  it('accepts a negative lead value', () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);
    fireEvent.blur(screen.getByRole('spinbutton', { name: 'Lag days for 1.1 — Task A' }), {
      target: { value: '-3' },
    });
    expect(capturedUpdatePayload).toEqual({ id: 'link-1', lag: -3 });
  });

  it('does not patch when the value is unchanged', () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);
    fireEvent.blur(screen.getByRole('spinbutton', { name: 'Lag days for 1.1 — Task A' }), {
      target: { value: '0' },
    });
    expect(updateMutateMock).not.toHaveBeenCalled();
  });

  it('does not patch when the field is cleared to a non-number', () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);
    fireEvent.blur(screen.getByRole('spinbutton', { name: 'Lag days for 1.1 — Task A' }), {
      target: { value: '' },
    });
    expect(updateMutateMock).not.toHaveBeenCalled();
  });

  it('clears a standing row error once a new lag is committed', () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Dependency type for 1.1 — Task A' }), {
      target: { value: 'SS' },
    });
    act(() => {
      capturedUpdateOpts?.onError?.(CYCLE_ERROR);
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.blur(screen.getByRole('spinbutton', { name: 'Lag days for 1.1 — Task A' }), {
      target: { value: '2' },
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AddDepRow — option filtering and the disabled Add affordance
// ---------------------------------------------------------------------------

describe('AddDepRow options', () => {
  it('omits the task itself and already-linked predecessors', () => {
    renderTab('task-b', [FS_LINK], [TASK_A, TASK_B, TASK_C]);
    const select = screen.getByRole('combobox', { name: 'Add predecessor' });
    expect(within(select).queryByRole('option', { name: '1.1 — Task A' })).toBeNull();
    expect(within(select).queryByRole('option', { name: '1.2 — Task B' })).toBeNull();
    expect(within(select).getByRole('option', { name: '1.3 — Task C' })).toBeInTheDocument();
  });

  it('omits already-linked successors', () => {
    renderTab('task-a', [FS_LINK], [TASK_A, TASK_B, TASK_C]);
    const select = screen.getByRole('combobox', { name: 'Add successor' });
    expect(within(select).queryByRole('option', { name: '1.2 — Task B' })).toBeNull();
    expect(within(select).getByRole('option', { name: '1.3 — Task C' })).toBeInTheDocument();
  });

  it('labels an option with the bare name when the task has no WBS', () => {
    renderTab('task-b', [], [TASK_B, TASK_NO_WBS]);
    const select = screen.getByRole('combobox', { name: 'Add predecessor' });
    expect(within(select).getByRole('option', { name: 'Task D' })).toBeInTheDocument();
  });

  it('enables Add only once a task is picked', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    const addBtn = screen.getByRole('button', { name: 'Add predecessor' });
    expect(addBtn).toBeDisabled();

    fireEvent.change(screen.getByRole('combobox', { name: 'Add predecessor' }), {
      target: { value: 'task-a' },
    });
    expect(addBtn).toBeEnabled();
  });

  it('keeps Add disabled while a create is already in flight', () => {
    depHookState.createPending = true;
    renderTab('task-b', [], [TASK_A, TASK_B]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Add predecessor' }), {
      target: { value: 'task-a' },
    });
    expect(screen.getByRole('button', { name: 'Add predecessor' })).toBeDisabled();
    expect(createMutateMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Adding a predecessor
// ---------------------------------------------------------------------------

describe('adding a predecessor', () => {
  function pickAndAdd(taskId = 'task-a', linkType?: string) {
    fireEvent.change(screen.getByRole('combobox', { name: 'Add predecessor' }), {
      target: { value: taskId },
    });
    if (linkType) {
      fireEvent.change(within(predSection()).getByRole('combobox', { name: 'Dependency type for new predecessor' }), {
        target: { value: linkType },
      });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add predecessor' }));
  }

  it('creates the dependency with the picked task as predecessor', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    pickAndAdd('task-a');
    expect(capturedCreatePayload).toEqual({
      predecessor: 'task-a',
      successor: 'task-b',
      dep_type: 'FS', lag: 0,
    });
  });

  it('sends the chosen link type', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    pickAndAdd('task-a', 'SS');
    expect(capturedCreatePayload).toMatchObject({ dep_type: 'SS' });
  });

  it('resets the picker back to its defaults on success', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    pickAndAdd('task-a', 'FF');
    act(() => {
      capturedCreateOpts?.onSuccess?.();
    });

    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Add predecessor' }).value,
    ).toBe('');
    expect(
      within(predSection()).getByRole<HTMLSelectElement>('combobox', { name: 'Dependency type for new predecessor' }).value,
    ).toBe('FS');
  });

  it('shows the cycle message and keeps the selection on a cycle rejection', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    pickAndAdd('task-a');
    act(() => {
      capturedCreateOpts?.onError?.(CYCLE_ERROR);
    });

    expect(screen.getByRole('alert').textContent).toMatch(/Task A/);
    // #356 AC — the picked predecessor survives the error.
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Add predecessor' }).value,
    ).toBe('task-a');
  });

  it('shows a generic message when the rejection is not a cycle', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    pickAndAdd('task-a');
    act(() => {
      capturedCreateOpts?.onError?.(new Error('boom'));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/Couldn’t add dependency/);
  });

  it('clears a standing error when the next add is attempted', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    pickAndAdd('task-a');
    act(() => {
      capturedCreateOpts?.onError?.(new Error('boom'));
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add predecessor' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Adding a successor
// ---------------------------------------------------------------------------

describe('adding a successor', () => {
  function pickAndAdd(taskId = 'task-a', linkType?: string) {
    fireEvent.change(screen.getByRole('combobox', { name: 'Add successor' }), {
      target: { value: taskId },
    });
    if (linkType) {
      fireEvent.change(within(succSection()).getByRole('combobox', { name: 'Dependency type for new successor' }), {
        target: { value: linkType },
      });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add successor' }));
  }

  it('creates the dependency with the current task as predecessor', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    pickAndAdd('task-a', 'SF');
    expect(capturedCreatePayload).toEqual({
      predecessor: 'task-b',
      successor: 'task-a',
      dep_type: 'SF', lag: 0,
    });
  });

  it('resets the picker back to its defaults on success', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    pickAndAdd('task-a', 'SF');
    act(() => {
      capturedCreateOpts?.onSuccess?.();
    });
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Add successor' }).value,
    ).toBe('');
    expect(
      within(succSection()).getByRole<HTMLSelectElement>('combobox', { name: 'Dependency type for new successor' }).value,
    ).toBe('FS');
  });

  it('shows the cycle message on a cycle rejection', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    pickAndAdd('task-a');
    act(() => {
      capturedCreateOpts?.onError?.(CYCLE_ERROR);
    });
    expect(screen.getByRole('alert').textContent).toMatch(/Task A/);
  });

  it('shows a generic message when the rejection is not a cycle', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    pickAndAdd('task-a');
    act(() => {
      capturedCreateOpts?.onError?.({ response: { data: {}, status: 500 } });
    });
    expect(screen.getByRole('alert').textContent).toMatch(/Couldn’t add dependency/);
  });
});

// ---------------------------------------------------------------------------
// Switching the drawer to another task resets the tab
// ---------------------------------------------------------------------------

describe('task switch', () => {
  it('clears the pending selection and any error when the task changes', () => {
    const { rerender } = renderWithProviders(
      <DependenciesTab
        task={TASK_B}
        tasks={[TASK_A, TASK_B, TASK_C]}
        links={[]}
        projectId="proj-1"
        programId={null}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Add predecessor' }), {
      target: { value: 'task-a' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add predecessor' }));
    act(() => {
      capturedCreateOpts?.onError?.(new Error('boom'));
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(
      <DependenciesTab
        task={TASK_C}
        tasks={[TASK_A, TASK_B, TASK_C]}
        links={[]}
        projectId="proj-1"
        programId={null}
      />,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Add predecessor' }).value,
    ).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Lag at CREATE, and control names that tell the links apart (#2916)
// ---------------------------------------------------------------------------

describe('DependenciesTab — lag at create (#2916)', () => {
  function predLag() {
    return within(predSection()).getByRole('spinbutton', {
      name: 'Lag days for new predecessor',
    });
  }

  it('sends the typed lag when adding a predecessor', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    fireEvent.change(within(predSection()).getByRole('combobox', { name: 'Add predecessor' }), {
      target: { value: 'task-a' },
    });
    fireEvent.change(predLag(), { target: { value: '3' } });
    fireEvent.click(within(predSection()).getByRole('button', { name: 'Add predecessor' }));
    expect(capturedCreatePayload).toMatchObject({ lag: 3 });
  });

  it('sends a NEGATIVE lag as a lead — the reason the field is signed', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    fireEvent.change(within(predSection()).getByRole('combobox', { name: 'Add predecessor' }), {
      target: { value: 'task-a' },
    });
    fireEvent.change(predLag(), { target: { value: '-2' } });
    fireEvent.click(within(predSection()).getByRole('button', { name: 'Add predecessor' }));
    expect(capturedCreatePayload).toMatchObject({ lag: -2 });
  });

  it('treats an emptied field as 0 rather than sending NaN', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    fireEvent.change(within(predSection()).getByRole('combobox', { name: 'Add predecessor' }), {
      target: { value: 'task-a' },
    });
    fireEvent.change(predLag(), { target: { value: '' } });
    fireEvent.click(within(predSection()).getByRole('button', { name: 'Add predecessor' }));
    expect(capturedCreatePayload).toMatchObject({ lag: 0 });
  });

  it('clamps to the bounds every surface shares, via the one shared parser', () => {
    renderTab('task-b', [], [TASK_A, TASK_B]);
    fireEvent.change(within(predSection()).getByRole('combobox', { name: 'Add predecessor' }), {
      target: { value: 'task-a' },
    });
    fireEvent.change(predLag(), { target: { value: '9999' } });
    fireEvent.click(within(predSection()).getByRole('button', { name: 'Add predecessor' }));
    expect(capturedCreatePayload).toMatchObject({ lag: 365 });
  });
});

describe('DependenciesTab — every link control names the link it acts on (#2916)', () => {
  it('gives two predecessor rows two DISTINCT lag controls', () => {
    // The defect this guards predates the lag-at-create work: a task with
    // several predecessors rendered N selects all called "Dependency type" and
    // N inputs all called "Lag days", so navigating by form control gave no way
    // to tell which link was which. Adding a third pair to the same section
    // would have made it worse, which is how it was noticed.
    renderTab(
      'task-b',
      [
        link({ id: 'l1', sourceId: 'task-a', targetId: 'task-b' }),
        link({ id: 'l2', sourceId: 'task-c', targetId: 'task-b' }),
      ],
      [TASK_A, TASK_B, TASK_C],
    );
    const lagNames = within(predSection())
      .getAllByRole('spinbutton')
      .map((el) => el.getAttribute('aria-label'));
    // Two per-link rows plus the add row — and no two alike.
    expect(lagNames.length).toBe(3);
    expect(new Set(lagNames).size).toBe(lagNames.length);
  });

  it('distinguishes the predecessor add-row from the successor add-row', () => {
    // Both sections render an add-row; before #2916 both said "Lag days".
    renderTab('task-b', [], [TASK_A, TASK_B]);
    expect(
      within(predSection()).getByRole('spinbutton', { name: 'Lag days for new predecessor' }),
    ).toBeInTheDocument();
    expect(
      within(succSection()).getByRole('spinbutton', { name: 'Lag days for new successor' }),
    ).toBeInTheDocument();
  });
});
