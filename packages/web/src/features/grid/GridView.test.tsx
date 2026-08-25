import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useTaskDrawerStore } from '@/stores/taskDrawerStore';
import { useTaskSelectionStore } from '@/stores/taskSelectionStore';
import { useWbsStore } from '@/stores/wbsStore';
import { ROLE_MEMBER, ROLE_SCHEDULER, ROLE_VIEWER } from '@/lib/roles';
import type { Task, Methodology } from '@/types';

// This file mounts the full GridView (TanStack Virtual + Query + router) ~104
// times, and the heaviest `renderGrid()` cases land within tens of milliseconds
// of vitest's 5000ms default — one timed out at 5022ms on a loaded CI runner
// (#2509). Because the suite runs `fileParallelism: false`, a busy machine tips
// them over. Raise the ceiling for THIS file only: a global bump would slow the
// failure signal for the whole ~12.6k-test suite and could mask genuine hangs.
//
// The cascade is why this matters more than one red test: a timed-out render is
// never unmounted, so the *next* test finds two `treegrid`s and fails with a
// misleading "Found multiple elements" that points nowhere near the real cause.
vi.setConfig({ testTimeout: 20_000 });

// JSDOM has no layout — TanStack Virtual relies on getBoundingClientRect for
// the scroll container. Stub a non-zero height so virtualised rows render.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        toJSON() {
          return this;
        },
      };
    },
  });
  // Reset persistence between tests so each test starts at the methodology default.
  window.localStorage.clear();
  // Default every test to an authoring role; viewer-gating tests set VIEWER.
  currentRoleMock = ROLE_MEMBER;
  // …and to the server saying yes; the gating tests below flip this (#3034).
  projectCanAuthorMock = true;
  // Grid selection lives in a module-scoped zustand store, so it survives unmount
  // and would leak a stale selection into the next spec's toolbar assertions.
  useTaskSelectionStore.setState({ selectedIds: new Set<string>() });
  projectIdMock = 'proj-1';
  projectDataUndefined = false;
  labelsMock = [
    { id: 'l1', name: 'Needs review', color: 'teal', position: 0, serverVersion: 1, taskCount: 0 },
    { id: 'l2', name: 'Blocked', color: 'rose', position: 1, serverVersion: 1, taskCount: 0 },
  ];
  resourcePoolMock = [
    { resourceId: 'r1', resource: { name: 'Alice Smith' } },
    { resourceId: 'r2', resource: { name: 'Bob Jones' } },
    { resourceId: 'r3', resource: { name: 'Carol Nunes' } },
  ];
});

const mockTasks: Task[] = [
  {
    id: 't1',
    wbs: '1',
    name: 'Planning',
    start: '2026-05-01',
    finish: '2026-05-10',
    duration: 10,
    progress: 50,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: true,
    isMilestone: false,
    status: 'IN_PROGRESS',
    assignees: [{ resourceId: 'r1', name: 'Alice Smith', units: 100 }],
    notes: '',
  },
  {
    id: 't2',
    wbs: '1.1',
    name: 'Requirements',
    start: '2026-05-01',
    finish: '2026-05-05',
    duration: 5,
    progress: 100,
    parentId: 't1',
    isCritical: true,
    isComplete: true,
    isSummary: false,
    isMilestone: false,
    status: 'COMPLETE',
    assignees: [
      { resourceId: 'r1', name: 'Alice Smith', units: 100 },
      { resourceId: 'r2', name: 'Bob Jones', units: 50 },
    ],
    notes: '',
  },
  {
    id: 't3',
    wbs: '2',
    name: 'Design',
    start: '2026-05-11',
    finish: '2026-05-20',
    duration: 10,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [{ resourceId: 'r2', name: 'Bob Jones', units: 100 }],
    notes: '',
  },
];

// Mutable so the "no project in scope" specs can drive every `!projectId` guard
// (persistence, drawer open, CSV filename, label-settings shortcut) without
// re-mocking the module. Reset to 'proj-1' in the top-level beforeEach.
let projectIdMock: string | undefined = 'proj-1';
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => projectIdMock }));

let scheduleTasksMockReturn: {
  tasks: typeof mockTasks | null;
  links: never[];
  isLoading: boolean;
  error: unknown;
} = { tasks: mockTasks, links: [], isLoading: false, error: null };

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => scheduleTasksMockReturn,
}));

let projectMethodology: Methodology = 'HYBRID';
let projectAgileFeatures = false;

// When true the project query has not resolved yet, so `project.data` is
// undefined and the methodology falls back to HYBRID.
let projectDataUndefined = false;

// The Grid's write gate reads the server's `can_author` (#3034), not the role
// ordinal — so the authoring assertions below drive THIS, not `currentRoleMock`.
let projectCanAuthorMock = true;

vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({
    data: projectDataUndefined
      ? undefined
      : {
          id: 'proj-1',
          methodology: projectMethodology,
          agile_features: projectAgileFeatures,
          can_author: projectCanAuthorMock,
        },
    isLoading: false,
  }),
}));

// Grid write controls (#2145) gate on the project role. Default to MEMBER so the
// authoring assertions below still apply; the viewer-gating tests override it.
let currentRoleMock: number | null = ROLE_MEMBER;
vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: () => ({ role: currentRoleMock, roleLabel: null, isLoading: false }),
}));

const bulkDeleteMutate = vi.fn();
const bulkRestoreMutate = vi.fn();
vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate: vi.fn(), isPending: false }),
  useBulkDeleteTasks: () => ({ mutate: bulkDeleteMutate, isPending: false }),
  useBulkRestoreTasks: () => ({ mutate: bulkRestoreMutate, isPending: false }),
  useReorderTasks: () => ({ mutate: vi.fn(), isPending: false }),
  useIndentTask: () => ({ mutate: vi.fn(), isPending: false }),
  useOutdentTask: () => ({ mutate: vi.fn(), isPending: false }),
  useReparentTask: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useSprints', () => ({
  useSprints: () => ({
    sprints: [{ id: 's1', name: 'Sprint 1', state: 'ACTIVE' }],
    isLoading: false,
    error: null,
  }),
}));

const exportTasksToCsv = vi.fn();
// Label catalog for the Label facet (#2383). Mutable so a test can present an
// empty project without re-mocking the module.
interface LabelRow {
  id: string;
  name: string;
  color: string;
  position: number;
  serverVersion: number;
  taskCount: number;
}
// `undefined` models the catalog query before it resolves.
let labelsMock: LabelRow[] | undefined = [
  { id: 'l1', name: 'Needs review', color: 'teal', position: 0, serverVersion: 1, taskCount: 0 },
  { id: 'l2', name: 'Blocked', color: 'rose', position: 1, serverVersion: 1, taskCount: 0 },
];
vi.mock('@/hooks/useLabels', () => ({
  useLabels: () => ({ data: labelsMock }),
}));

// Owner roster for the Owner facet (#2387) — the project's resource pool, which
// deliberately includes someone with no rows so the visible `0` is exercised.
interface PoolRow {
  resourceId: string;
  resource: { name: string };
}
// `undefined` models the pool query before it resolves.
let resourcePoolMock: PoolRow[] | undefined = [
  { resourceId: 'r1', resource: { name: 'Alice Smith' } },
  { resourceId: 'r2', resource: { name: 'Bob Jones' } },
  { resourceId: 'r3', resource: { name: 'Carol Nunes' } },
];
vi.mock('@/hooks/useProjectResourcePool', () => ({
  useProjectResourcePool: () => ({ data: resourcePoolMock }),
}));

vi.mock('@/utils/exportCsv', () => ({
  exportTasksToCsv: (...args: unknown[]) => {
    exportTasksToCsv(...args);
  },
}));

vi.mock('@/features/board/TaskFormModal', () => ({
  TaskFormModal: ({ onClose, parentId }: { onClose: () => void; parentId?: string }) => (
    <div role="dialog" aria-label="Task form">
      <span data-testid="parent-id">{parentId ?? 'none'}</span>
      <button onClick={onClose}>Close form</button>
    </div>
  ),
}));

// Stub the virtualizer to render every row at its estimated size — keeps tests
// focused on behaviour, not virtualisation mechanics.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    estimateSize,
  }: {
    count: number;
    estimateSize: (i: number) => number;
  }) => {
    const items = Array.from({ length: count }, (_, index) => ({
      index,
      key: index,
      start: index * estimateSize(index),
      size: estimateSize(index),
      end: (index + 1) * estimateSize(index),
      lane: 0,
    }));
    let totalSize = 0;
    for (let i = 0; i < count; i++) totalSize += estimateSize(i);
    return {
      getVirtualItems: () => items,
      getTotalSize: () => totalSize,
    };
  },
}));

async function renderGrid(initialEntries?: string[]) {
  const { GridView } = await import('./GridView');
  return renderWithRouter(<GridView />, initialEntries ? { initialEntries } : undefined);
}

/**
 * Same render, but hands back the router so a test can read the query string.
 * `window.location` is untouched by MemoryRouter, so asserting on it proves
 * nothing — the router's own location is the observable.
 */
async function renderGridWithRouter(initialEntries: string[] = ['/']) {
  const { GridView } = await import('./GridView');
  const router = createMemoryRouter([{ path: '*', element: <GridView /> }], { initialEntries });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    search: () => router.state.location.search,
    pathname: () => router.state.location.pathname,
  };
}

describe('GridView — methodology default', () => {
  beforeEach(() => {
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    projectAgileFeatures = false;
  });

  it('defaults to outline mode when methodology is HYBRID', async () => {
    projectMethodology = 'HYBRID';
    await renderGrid();
    await waitFor(() => {
      expect(screen.getByRole('treegrid', { name: /outline task tree/i })).toBeInTheDocument();
    });
  });

  it('defaults to outline mode when methodology is WATERFALL', async () => {
    projectMethodology = 'WATERFALL';
    await renderGrid();
    await waitFor(() => {
      expect(screen.getByRole('treegrid', { name: /outline task tree/i })).toBeInTheDocument();
    });
  });

  it('defaults to flat mode when methodology is AGILE', async () => {
    projectMethodology = 'AGILE';
    await renderGrid();
    await waitFor(() => {
      // Flat mode renders role="grid"; outline renders role="treegrid".
      expect(screen.queryByRole('treegrid')).not.toBeInTheDocument();
      expect(screen.getByRole('grid', { name: /task list/i })).toBeInTheDocument();
    });
  });
});

describe('GridView — mode toggle', () => {
  beforeEach(() => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
  });

  it('switches between flat / outline / grouped via the segmented control', async () => {
    const user = userEvent.setup();
    await renderGrid();

    // Default in HYBRID is outline.
    expect(screen.getByRole('treegrid', { name: /outline task tree/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Flat list' }));
    expect(await screen.findByRole('grid', { name: /task list/i })).toBeInTheDocument();
    expect(screen.queryByRole('treegrid')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Grouped' }));
    // Grouped also uses role="grid"
    expect(screen.getByRole('grid', { name: /task list/i })).toBeInTheDocument();
    // Group-by selector now visible
    expect(screen.getByLabelText(/group by dimension/i)).toBeInTheDocument();
  });

  it('persists mode to localStorage on change', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(screen.getByRole('button', { name: 'Flat list' }));
    expect(window.localStorage.getItem('trueppm.grid.mode.proj-1.v1')).toBe('flat');
  });

  it('reads persisted mode on mount, overriding methodology default', async () => {
    projectMethodology = 'AGILE'; // would default to flat
    window.localStorage.setItem('trueppm.grid.mode.proj-1.v1', 'outline');
    await renderGrid();
    await waitFor(() => {
      expect(screen.getByRole('treegrid', { name: /outline task tree/i })).toBeInTheDocument();
    });
  });

  it('the ?due=overdue drill-down shows flat mode WITHOUT persisting it (#1691)', async () => {
    projectMethodology = 'HYBRID'; // would default to outline
    await renderGrid(['/?due=overdue']);
    await waitFor(() => {
      // Derived flat view — outline (the methodology default) is not rendered.
      expect(screen.getByRole('grid', { name: /task list/i })).toBeInTheDocument();
      expect(screen.queryByRole('treegrid')).not.toBeInTheDocument();
    });
    // Crucially, the persisted preference is untouched (regression guard):
    expect(window.localStorage.getItem('trueppm.grid.mode.proj-1.v1')).toBeNull();
  });

  it('a deliberate mode change while overdue wins over the derived flat view', async () => {
    const user = userEvent.setup();
    projectMethodology = 'HYBRID';
    await renderGrid(['/?due=overdue']);
    await screen.findByRole('grid', { name: /task list/i }); // derived flat
    await user.click(screen.getByRole('button', { name: 'Outline tree' }));
    await waitFor(() => {
      expect(screen.getByRole('treegrid', { name: /outline task tree/i })).toBeInTheDocument();
    });
    // The explicit choice persists.
    expect(window.localStorage.getItem('trueppm.grid.mode.proj-1.v1')).toBe('outline');
  });

  it('aria-pressed reflects active mode on the toggle buttons', async () => {
    const user = userEvent.setup();
    await renderGrid();
    const flatBtn = screen.getByRole('button', { name: 'Flat list' });
    const outlineBtn = screen.getByRole('button', { name: 'Outline tree' });
    expect(outlineBtn).toHaveAttribute('aria-pressed', 'true');
    expect(flatBtn).toHaveAttribute('aria-pressed', 'false');
    await user.click(flatBtn);
    await waitFor(() => {
      expect(flatBtn).toHaveAttribute('aria-pressed', 'true');
      expect(outlineBtn).toHaveAttribute('aria-pressed', 'false');
    });
  });
});

describe('GridView — group-by', () => {
  beforeEach(() => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
  });

  it('group-by selector is hidden when mode is not grouped', async () => {
    await renderGrid();
    expect(screen.queryByLabelText(/group by dimension/i)).not.toBeInTheDocument();
  });

  it('persists group-by selection to localStorage', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(screen.getByRole('button', { name: 'Grouped' }));
    const select = await screen.findByLabelText(/group by dimension/i);
    await user.selectOptions(select, 'status');
    expect(window.localStorage.getItem('trueppm.grid.groupBy.proj-1.v1')).toBe('status');
  });

  it('hides Sprint option when project does not have agile features', async () => {
    const user = userEvent.setup();
    projectAgileFeatures = false;
    await renderGrid();
    await user.click(screen.getByRole('button', { name: 'Grouped' }));
    const select = await screen.findByLabelText(/group by dimension/i);
    expect(select.querySelector('option[value="sprint"]')).toBeNull();
  });

  it('shows Sprint option when project has agile features', async () => {
    const user = userEvent.setup();
    projectAgileFeatures = true;
    await renderGrid();
    await user.click(screen.getByRole('button', { name: 'Grouped' }));
    const select = await screen.findByLabelText(/group by dimension/i);
    expect(select.querySelector('option[value="sprint"]')).not.toBeNull();
  });

  it('resource grouping duplicates multi-assignee tasks across groups', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(screen.getByRole('button', { name: 'Grouped' }));
    const select = await screen.findByLabelText(/group by dimension/i);
    await user.selectOptions(select, 'resource');
    // t2 has both Alice and Bob — both group headers should appear, and t2's row appears twice.
    await waitFor(() => {
      expect(screen.getByText('Alice Smith')).toBeInTheDocument();
      expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    });
    // "Requirements" appears under Alice (own task) AND Bob (shared)
    const requirementCells = screen.getAllByText('Requirements');
    expect(requirementCells.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the resource-duplication help indicator when grouped by resource', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(screen.getByRole('button', { name: 'Grouped' }));
    const select = await screen.findByLabelText(/group by dimension/i);
    await user.selectOptions(select, 'resource');
    expect(
      screen.getByLabelText(/tasks with multiple assignees appear under each resource/i),
    ).toBeInTheDocument();
  });
});

describe('GridView — search and filtering', () => {
  beforeEach(() => {
    projectMethodology = 'AGILE'; // flat default for search assertions
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
  });

  it('filters tasks by search term in flat mode', async () => {
    const user = userEvent.setup();
    await renderGrid();
    expect(await screen.findByText('Planning')).toBeInTheDocument();
    expect(screen.getByText('Design')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Search tasks'), 'design');
    await waitFor(
      () => {
        expect(screen.queryByText('Planning')).not.toBeInTheDocument();
        expect(screen.getByText('Design')).toBeInTheDocument();
      },
      { timeout: 1000 },
    );
  });

  it('shows filtered-empty state when search yields no matches', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.type(screen.getByLabelText('Search tasks'), 'zzzzzzz');
    expect(await screen.findByText(/no tasks match these filters/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear filters/i })).toBeInTheDocument();
  });

  it('Clear filters button resets the search', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.type(screen.getByLabelText('Search tasks'), 'zzzzzzz');
    await user.click(await screen.findByRole('button', { name: /clear filters/i }));
    expect(await screen.findByText('Planning')).toBeInTheDocument();
  });
});

describe('GridView — empty / loading / error states', () => {
  it('shows the no-tasks empty state when project has zero tasks', async () => {
    scheduleTasksMockReturn = { tasks: [], links: [], isLoading: false, error: null };
    await renderGrid();
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
  });

  it('shows skeleton loader when tasks are loading', async () => {
    scheduleTasksMockReturn = { tasks: null, links: [], isLoading: true, error: null };
    await renderGrid();
    const region = await screen
      .findByRole('generic', { hidden: true }, { timeout: 1000 })
      .catch(() => null);
    // The skeleton uses aria-busy on its container; assert that instead.
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(region ?? document.body).toBeTruthy();
  });

  it('shows error state with retry on fetch failure', async () => {
    scheduleTasksMockReturn = {
      tasks: null,
      links: [],
      isLoading: false,
      error: new Error('boom'),
    };
    await renderGrid();
    expect(screen.getByText(/couldn't load tasks/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});

describe('GridView — bulk delete', () => {
  beforeEach(() => {
    projectMethodology = 'AGILE'; // flat
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    bulkDeleteMutate.mockClear();
  });

  it('shows the confirm strip after Delete is clicked with rows selected', async () => {
    const user = userEvent.setup();
    await renderGrid();
    // Select one row.
    const checkboxes = screen.getAllByLabelText(/^Select /);
    await user.click(checkboxes[0]);
    // Toolbar "Delete" appears.
    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    expect(screen.getByRole('alertdialog', { name: /confirm deletion/i })).toBeInTheDocument();
  });

  it('bulk-select chrome is suppressed in outline mode', async () => {
    const user = userEvent.setup();
    projectMethodology = 'HYBRID'; // default is outline
    await renderGrid();
    // No "Select all tasks" checkbox in outline mode.
    expect(screen.queryByLabelText(/select all tasks/i)).not.toBeInTheDocument();
    // Switch to flat — the checkbox appears.
    await user.click(screen.getByRole('button', { name: 'Flat list' }));
    expect(await screen.findByLabelText(/select all tasks/i)).toBeInTheDocument();
  });

  it('select-all checkbox carries the enlarged (WCAG 2.5.8) touch hit-area (#1703)', async () => {
    const user = userEvent.setup();
    projectMethodology = 'HYBRID';
    await renderGrid();
    await user.click(screen.getByRole('button', { name: 'Flat list' }));
    const selectAll = await screen.findByLabelText(/select all tasks/i);
    const label = selectAll.closest('label');
    expect(label).not.toBeNull();
    // Capped at 36px (before:h-9) so it fits the h-9 wrapping toolbar line; still
    // above the WCAG 2.5.8 24px floor.
    expect(label?.className).toMatch(/before:h-9/);
    expect(label?.className).toMatch(/before:w-9/);
    expect(label?.className).toMatch(/md:before:hidden/);
  });
});

describe('GridView — toolbar actions', () => {
  beforeEach(() => {
    projectMethodology = 'AGILE';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    exportTasksToCsv.mockClear();
  });

  it('clicking + Task opens the task form modal', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(screen.getByRole('button', { name: /^\+ task$/i }));
    expect(await screen.findByRole('dialog', { name: /task form/i })).toBeInTheDocument();
  });

  it('exports filtered tasks to CSV', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(screen.getByRole('button', { name: /export tasks as csv/i }));
    expect(exportTasksToCsv).toHaveBeenCalledTimes(1);
    expect(exportTasksToCsv).toHaveBeenCalledWith(
      expect.any(Array),
      expect.stringContaining('proj-1'),
    );
  });
});

describe('GridView — extra coverage', () => {
  beforeEach(() => {
    projectMethodology = 'AGILE';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    bulkDeleteMutate.mockReset();
    bulkRestoreMutate.mockReset();
  });

  it('confirms bulk delete and dispatches the mutation on success', async () => {
    bulkDeleteMutate.mockImplementation((_ids: string[], opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });
    const user = userEvent.setup();
    await renderGrid();
    const checkboxes = screen.getAllByLabelText(/^Select /);
    await user.click(checkboxes[0]);
    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    await user.click(await screen.findByRole('button', { name: /confirm delete/i }));
    expect(bulkDeleteMutate).toHaveBeenCalled();
    expect(await screen.findByText(/task.* deleted/i)).toBeInTheDocument();
  });

  it('offers Undo on the delete toast and restores via bulkRestore (#2078)', async () => {
    let deletedIds: string[] = [];
    bulkDeleteMutate.mockImplementation((ids: string[], opts?: { onSuccess?: () => void }) => {
      deletedIds = ids;
      opts?.onSuccess?.();
    });
    const user = userEvent.setup();
    await renderGrid();
    const checkboxes = screen.getAllByLabelText(/^Select /);
    await user.click(checkboxes[0]);
    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    await user.click(await screen.findByRole('button', { name: /confirm delete/i }));

    // The success toast offers Undo; clicking it restores the same ids.
    const undo = await screen.findByRole('button', { name: /^undo$/i });
    await user.click(undo);
    expect(bulkRestoreMutate).toHaveBeenCalledWith(deletedIds, expect.anything());
  });

  it('shows the error toast when bulk delete fails', async () => {
    bulkDeleteMutate.mockImplementation((_ids: string[], opts?: { onError?: () => void }) => {
      opts?.onError?.();
    });
    const user = userEvent.setup();
    await renderGrid();
    const checkboxes = screen.getAllByLabelText(/^Select /);
    await user.click(checkboxes[0]);
    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    await user.click(await screen.findByRole('button', { name: /confirm delete/i }));
    expect(await screen.findByText(/couldn't delete tasks/i)).toBeInTheDocument();
  });

  it('cancelling the bulk-delete confirm strip restores the toolbar', async () => {
    const user = userEvent.setup();
    await renderGrid();
    const checkboxes = screen.getAllByLabelText(/^Select /);
    await user.click(checkboxes[0]);
    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    await user.click(await screen.findByRole('button', { name: /^cancel$/i }));
    expect(await screen.findByRole('searchbox', { name: /search tasks/i })).toBeInTheDocument();
  });

  it('clearing chips via × removes the corresponding filter', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.type(screen.getByLabelText('Search tasks'), 'design');
    const removeBtn = await screen.findByLabelText(/Remove "design" filter/i);
    await user.click(removeBtn);
    // Chip strip is gone; full task list returns.
    expect(screen.queryByLabelText(/Remove "design" filter/i)).not.toBeInTheDocument();
  });

  it('renders the empty-state CTA when project has zero tasks', async () => {
    scheduleTasksMockReturn = { tasks: [], links: [], isLoading: false, error: null };
    await renderGrid();
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ add task/i })).toBeInTheDocument();
  });

  it('clicking + Add task in the empty state opens the form modal', async () => {
    const user = userEvent.setup();
    scheduleTasksMockReturn = { tasks: [], links: [], isLoading: false, error: null };
    await renderGrid();
    await user.click(screen.getByRole('button', { name: /\+ add task/i }));
    expect(await screen.findByRole('dialog', { name: /task form/i })).toBeInTheDocument();
  });

  it('clicking the search-chip × clears the chip', async () => {
    const user = userEvent.setup();
    await renderGrid();
    const search = screen.getByLabelText('Search tasks');
    await user.type(search, 'planning');
    const chipRemove = await screen.findByLabelText(/Remove "planning" filter/i);
    await user.click(chipRemove);
    expect(screen.queryByLabelText(/Remove "planning" filter/i)).not.toBeInTheDocument();
  });

  it('Expand/Collapse all buttons are visible in outline mode and clickable', async () => {
    projectMethodology = 'HYBRID'; // outline default
    const user = userEvent.setup();
    await renderGrid();
    const expandBtn = screen.getByRole('button', { name: /^expand all$/i });
    const collapseBtn = screen.getByRole('button', { name: /^collapse all$/i });
    await user.click(expandBtn);
    await user.click(collapseBtn);
    // Buttons remain present after click (counter-based imperatives).
    expect(expandBtn).toBeInTheDocument();
  });

  it('Expand/Collapse all buttons are hidden in flat mode', async () => {
    projectMethodology = 'AGILE'; // flat default
    await renderGrid();
    expect(screen.queryByRole('button', { name: /^expand all$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^collapse all$/i })).not.toBeInTheDocument();
  });

  it('+ Child button appears in outline mode only when a row is selected', async () => {
    projectMethodology = 'HYBRID';
    await renderGrid();
    // Initially no row is selected — + Child is not present.
    expect(screen.queryByRole('button', { name: /add child task/i })).not.toBeInTheDocument();
  });

  it('switching from outline to flat clears the outline selection on next modal close', async () => {
    projectMethodology = 'HYBRID';
    const user = userEvent.setup();
    await renderGrid();
    // Open + Task in outline mode → modal with no parent.
    await user.click(screen.getByRole('button', { name: /^\+ task$/i }));
    expect(await screen.findByRole('dialog', { name: /task form/i })).toBeInTheDocument();
    await user.click(screen.getByText(/close form/i));
    // Switch to flat mode and open + Task — onClose should now also reset
    // the outline-store selectedTaskId (line 342 branch).
    await user.click(screen.getByRole('button', { name: 'Flat list' }));
    await user.click(screen.getByRole('button', { name: /^\+ task$/i }));
    await user.click(screen.getByText(/close form/i));
    expect(screen.queryByRole('dialog', { name: /task form/i })).not.toBeInTheDocument();
  });
});

describe('GridView — URL-synced filters (#2046)', () => {
  beforeEach(() => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
  });

  it('seeds the search filter from ?q= so a shared/reloaded link restores it', async () => {
    await renderGrid(['/projects/proj-1/grid?q=Design']);
    const searchBox = await screen.findByRole('searchbox', { name: /search tasks/i });
    expect(searchBox).toHaveValue('Design');
  });
});

describe('GridView — ?task= deep-link drawer (#2031)', () => {
  beforeEach(() => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    useTaskDrawerStore.setState({ task: null, projectId: null });
  });

  it('opens the app-wide task drawer on the linked task once the list loads', async () => {
    await renderGrid(['/projects/proj-1/grid?task=t2']);
    await waitFor(() => {
      const open = useTaskDrawerStore.getState();
      expect(open.task?.id).toBe('t2');
      expect(open.projectId).toBe('proj-1');
    });
  });

  it('does not open a drawer for a ?task= id that is not in the loaded list', async () => {
    await renderGrid(['/projects/proj-1/grid?task=does-not-exist']);
    // Let the consume-once effect run.
    await screen.findByRole('treegrid', { name: /outline task tree/i });
    expect(useTaskDrawerStore.getState().task).toBeNull();
  });
});

describe('GridView — mode / group-by announcements (live region)', () => {
  beforeEach(() => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    projectAgileFeatures = false;
  });

  it('announces the task count when switching to flat mode', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(screen.getByRole('button', { name: 'Flat list' }));
    // 3 mock tasks → pluralized announcement.
    expect(await screen.findByText('Switched to flat mode. 3 tasks shown.')).toBeInTheDocument();
  });

  it('announces the outline switch', async () => {
    const user = userEvent.setup();
    projectMethodology = 'AGILE'; // starts flat
    await renderGrid();
    await user.click(screen.getByRole('button', { name: 'Outline tree' }));
    expect(await screen.findByText('Switched to outline mode.')).toBeInTheDocument();
  });

  it('announces grouped mode and the active group-by dimension', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(screen.getByRole('button', { name: 'Grouped' }));
    expect(
      await screen.findByText('Switched to grouped mode. Grouped by phase.'),
    ).toBeInTheDocument();
  });

  it('announces the resource caveat when grouping by resource, plain text otherwise', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(screen.getByRole('button', { name: 'Grouped' }));
    const select = await screen.findByLabelText(/group by dimension/i);

    await user.selectOptions(select, 'status');
    expect(await screen.findByText('Grouped by status.')).toBeInTheDocument();

    await user.selectOptions(select, 'resource');
    expect(
      await screen.findByText(/Grouped by resource\. Tasks with multiple assignees/i),
    ).toBeInTheDocument();
  });
});

describe('GridView — outline + Child parenting (#2078)', () => {
  beforeEach(() => {
    projectMethodology = 'HYBRID'; // outline default
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    useWbsStore.setState({ selectedTaskId: null });
  });

  it('+ Child opens the modal parented to the selected outline row', async () => {
    const user = userEvent.setup();
    await renderGrid();
    // Select a leaf row in the outline.
    const designCell = await screen.findByText('Design');
    const row = designCell.closest('[role="row"]');
    expect(row).not.toBeNull();
    await user.click(row as HTMLElement);

    // + Child now surfaces (showAddChild = outline && selection).
    const addChild = await screen.findByRole('button', { name: /add child task under selected/i });
    await user.click(addChild);

    const dialog = await screen.findByRole('dialog', { name: /task form/i });
    // Modal is parented to the selected task id (t3 = Design).
    expect(within(dialog).getByTestId('parent-id')).toHaveTextContent('t3');
  });
});

describe('GridView — chip removal branches (#2046)', () => {
  beforeEach(() => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
  });

  it('removing the Overdue chip reverts the derived flat view to the persisted mode', async () => {
    const user = userEvent.setup();
    await renderGrid(['/projects/proj-1/grid?due=overdue']);
    // Derived flat view while overdue.
    await screen.findByRole('grid', { name: /task list/i });
    await user.click(screen.getByLabelText(/Remove Overdue filter/i));
    // Overdue cleared → effective mode falls back to the HYBRID outline default.
    await waitFor(() => {
      expect(screen.getByRole('treegrid', { name: /outline task tree/i })).toBeInTheDocument();
    });
  });

  it('removing the Owner and Status chips clears each filter', async () => {
    const user = userEvent.setup();
    await renderGrid(['/projects/proj-1/grid?owner=Alice&status=IN_PROGRESS']);
    // Both chips seed from the URL.
    await user.click(await screen.findByLabelText(/Remove Owner: Alice filter/i));
    expect(screen.queryByLabelText(/Remove Owner: Alice filter/i)).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(/Remove Status: .* filter/i));
    expect(screen.queryByLabelText(/Remove Status: .* filter/i)).not.toBeInTheDocument();
  });
});

describe('GridView — bulk restore result toasts (#2078)', () => {
  beforeEach(() => {
    projectMethodology = 'AGILE'; // flat
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    bulkDeleteMutate.mockReset();
    bulkRestoreMutate.mockReset();
    // Delete always succeeds so the Undo affordance is offered.
    bulkDeleteMutate.mockImplementation((_ids: string[], opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });
  });

  async function deleteThenUndo(user: ReturnType<typeof userEvent.setup>) {
    const checkboxes = screen.getAllByLabelText(/^Select /);
    await user.click(checkboxes[0]);
    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    await user.click(await screen.findByRole('button', { name: /confirm delete/i }));
    await user.click(await screen.findByRole('button', { name: /^undo$/i }));
  }

  it('shows a "restored" toast when the undo restore succeeds', async () => {
    bulkRestoreMutate.mockImplementation((_ids: string[], opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });
    const user = userEvent.setup();
    await renderGrid();
    await deleteThenUndo(user);
    expect(await screen.findByText(/task.* restored/i)).toBeInTheDocument();
  });

  it('shows a "couldn\'t restore" toast when the undo restore fails', async () => {
    bulkRestoreMutate.mockImplementation((_ids: string[], opts?: { onError?: () => void }) => {
      opts?.onError?.();
    });
    const user = userEvent.setup();
    await renderGrid();
    await deleteThenUndo(user);
    expect(await screen.findByText(/couldn't restore tasks/i)).toBeInTheDocument();
  });
});

describe('GridView — authoring gate (#2145, rewired to can_author in #3034)', () => {
  beforeEach(() => {
    projectMethodology = 'AGILE'; // flat — where select-all/Delete/+Task live
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
  });

  it('a Viewer sees no select-all, no + Task, and no bulk-delete affordance', async () => {
    currentRoleMock = ROLE_VIEWER;
    projectCanAuthorMock = false;
    await renderGrid();
    // The list still renders (read is allowed)…
    expect(await screen.findByText('Planning')).toBeInTheDocument();
    // …but every write control is suppressed.
    expect(screen.queryByLabelText(/select all tasks/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^\+ task$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /^Select /i })).not.toBeInTheDocument();
  });

  it('a Member sees the select-all box and + Task button', async () => {
    currentRoleMock = ROLE_MEMBER;
    projectCanAuthorMock = true;
    await renderGrid();
    expect(await screen.findByLabelText(/select all tasks/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^\+ task$/i })).toBeInTheDocument();
  });

  it('a Scheduler is refused the write controls even though the ordinal is above Member', async () => {
    // The regression this test exists for (#3034): the gate used to be
    // `role >= ROLE_MEMBER`, and ROLE_SCHEDULER (200) satisfies it. The server
    // does not — bulk delete goes to TaskBulkView, which carries
    // IsProjectPlanAuthor and 403s. The role mock stays SCHEDULER precisely so
    // this fails again if anyone re-derives the gate from the ordinal.
    currentRoleMock = ROLE_SCHEDULER;
    projectCanAuthorMock = false;
    await renderGrid();
    expect(await screen.findByText('Planning')).toBeInTheDocument();
    expect(screen.queryByLabelText(/select all tasks/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^\+ task$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /^Select /i })).not.toBeInTheDocument();
  });

  it('the empty-state CTA is hidden for a Viewer', async () => {
    currentRoleMock = ROLE_VIEWER;
    projectCanAuthorMock = false;
    scheduleTasksMockReturn = { tasks: [], links: [], isLoading: false, error: null };
    await renderGrid();
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /\+ add task/i })).not.toBeInTheDocument();
  });
});

describe('GridView — label facet (#2383)', () => {
  beforeEach(() => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    labelsMock = [
      { id: 'l1', name: 'Needs review', color: 'teal', position: 0, serverVersion: 1, taskCount: 0 },
      { id: 'l2', name: 'Blocked', color: 'rose', position: 1, serverVersion: 1, taskCount: 0 },
    ];
  });

  it('renders the Label trigger in the toolbar', async () => {
    await renderGrid();
    expect(await screen.findByRole('button', { name: 'Label: any' })).toBeInTheDocument();
  });

  it('seeds the selection from ?fl= so a shared link restores it', async () => {
    await renderGrid(['/projects/proj-1/grid?fl=l1']);
    expect(await screen.findByRole('button', { name: /Label: Needs review/ })).toBeInTheDocument();
    // The chip strip mounts for a label-only filter.
    expect(screen.getByRole('button', { name: 'Remove filter: label Needs review' })).toBeInTheDocument();
  });

  it('is purely additive — an existing ?owner=&status= link is unaffected', async () => {
    // The regression this guards: adopting `?fl=` must not rewrite, redirect, or
    // invalidate a Grid link bookmarked before the facet existed.
    await renderGrid(['/projects/proj-1/grid?owner=Alice%20Smith&status=IN_PROGRESS']);
    // Assert on the chips' remove buttons, not the bare text: since #2387 the
    // toolbar trigger reads "Status: In progress" too, so `getByText` would hit
    // two nodes. `?owner=` here is a *name* (the pre-#2387 format) and must
    // still resolve — the predicate matches resource id or name.
    expect(await screen.findByLabelText('Remove Owner: Alice Smith filter')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove Status: In progress filter')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Label: any' })).toBeInTheDocument();
    expect(window.location.search).not.toContain('fl=');
  });

  it('ignores a ?fl= id the catalog no longer knows, rather than filtering everything out', async () => {
    await renderGrid(['/projects/proj-1/grid?fl=deleted-label']);
    // Trigger reports no *resolvable* selection and the rows are not emptied.
    expect(await screen.findByRole('button', { name: 'Label: any' })).toBeInTheDocument();
    expect(screen.getByText('Planning')).toBeInTheDocument();
  });

  it('offers the label-settings route when the project has no labels', async () => {
    labelsMock = [];
    const user = userEvent.setup();
    await renderGrid();
    await user.click(await screen.findByRole('button', { name: 'Label: none yet' }));
    expect(screen.getByText('No labels in this project yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open label settings' })).toBeInTheDocument();
  });
});

describe('GridView — Owner and Status facets (#2387)', () => {
  beforeEach(() => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    labelsMock = [
      { id: 'l1', name: 'Needs review', color: 'teal', position: 0, serverVersion: 1, taskCount: 0 },
      { id: 'l2', name: 'Blocked', color: 'rose', position: 1, serverVersion: 1, taskCount: 0 },
    ];
    resourcePoolMock = [
      { resourceId: 'r1', resource: { name: 'Alice Smith' } },
      { resourceId: 'r2', resource: { name: 'Bob Jones' } },
      { resourceId: 'r3', resource: { name: 'Carol Nunes' } },
    ];
  });

  it('renders all three facet triggers, left to right', async () => {
    await renderGrid();
    // The gap this issue closes: Owner and Status had working state, working
    // predicates and removable chips, but no control to *set* them.
    expect(await screen.findByRole('button', { name: 'Owner: any' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Status: any' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Label: any' })).toBeInTheDocument();
  });

  it('selecting an owner filters the rows and mirrors into ?owner=', async () => {
    const user = userEvent.setup();
    const { search } = await renderGridWithRouter();
    await user.click(await screen.findByRole('button', { name: 'Owner: any' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Alice Smith/ }));
    await waitFor(() => expect(search()).toContain('owner=r1'));
    // Alice is on Planning and Requirements; Design (Bob only) drops out.
    expect(screen.getByText('Requirements')).toBeInTheDocument();
    expect(screen.queryByText('Design')).not.toBeInTheDocument();
  });

  it('ORs within the Owner facet — two owners widen the result', async () => {
    const user = userEvent.setup();
    const { search } = await renderGridWithRouter();
    await user.click(await screen.findByRole('button', { name: 'Owner: any' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Alice Smith/ }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Bob Jones/ }));
    // Comma-separated, in selection order — the same list format as `?fl=`.
    await waitFor(() => expect(search()).toContain('owner=r1%2Cr2'));
    // Both chips are present — one per value, so either can be dropped alone.
    expect(screen.getByLabelText('Remove Owner: Alice Smith filter')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove Owner: Bob Jones filter')).toBeInTheDocument();
  });

  it('shows a visible 0 for a roster member with no rows here', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(await screen.findByRole('button', { name: 'Owner: any' }));
    // Carol is on the project but owns none of the loaded tasks.
    expect(screen.getByRole('menuitemcheckbox', { name: /Carol Nunes/ })).toHaveTextContent('0');
  });

  it('restores a multi-value ?owner= and ?status= from the URL', async () => {
    await renderGrid(['/projects/proj-1/grid?owner=r1,r2&status=IN_PROGRESS,COMPLETE']);
    expect(await screen.findByLabelText('Remove Owner: Alice Smith filter')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove Owner: Bob Jones filter')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove Status: In progress filter')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove Status: Done filter')).toBeInTheDocument();
  });

  it('drops an unrecognized ?status= value rather than rendering an unremovable chip', async () => {
    await renderGrid(['/projects/proj-1/grid?status=IN_PROGRESS,CANCELLED']);
    expect(await screen.findByLabelText('Remove Status: In progress filter')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Remove Status: CANCELLED/)).not.toBeInTheDocument();
  });

  it('opens one panel at a time — opening Status closes Owner', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(await screen.findByRole('button', { name: 'Owner: any' }));
    expect(screen.getByRole('menu', { name: 'Filter by owner' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Status: any' }));
    // No stacking: the Owner panel is gone, not merely behind the Status one.
    expect(screen.queryByRole('menu', { name: 'Filter by owner' })).not.toBeInTheDocument();
    expect(screen.getByRole('menu', { name: 'Filter by status' })).toBeInTheDocument();
  });

  it('lists the chips in toolbar order and clears them all at once', async () => {
    const user = userEvent.setup();
    const { search } = await renderGridWithRouter([
      '/projects/proj-1/grid?owner=r1&status=IN_PROGRESS&fl=l1',
    ]);
    const removeLabels = (await screen.findAllByRole('button'))
      .map((b) => b.getAttribute('aria-label'))
      .filter((l): l is string => Boolean(l?.startsWith('Remove ')));
    expect(removeLabels).toEqual([
      'Remove Owner: Alice Smith filter',
      'Remove Status: In progress filter',
      'Remove filter: label Needs review',
    ]);
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    // Every key is dropped, not merely emptied — an unfiltered grid has a clean URL.
    await waitFor(() => expect(search()).not.toContain('owner='));
    expect(search()).not.toContain('status=');
    expect(search()).not.toContain('fl=');
  });

  it('names each facet and offers the most useful drop when nothing matches', async () => {
    const user = userEvent.setup();
    // Carol owns nothing and COMPLETE has rows, so the intersection is empty.
    await renderGrid(['/projects/proj-1/grid?owner=r3&status=COMPLETE']);
    expect(await screen.findByText(/No tasks match both filters/)).toBeInTheDocument();
    // Each facet's standalone count is stated, so an empty intersection reads as
    // an intersection rather than as a broken filter.
    expect(screen.getByText(/Each filter has rows on its own/)).toBeInTheDocument();
    // Dropping Owner recovers the COMPLETE rows; dropping Status recovers none,
    // because Carol owns nothing. The offer is the one that actually helps.
    await user.click(screen.getByRole('button', { name: /^Drop Owner:/ }));
    expect(await screen.findByText('Requirements')).toBeInTheDocument();
  });

  it('keeps the plain single-facet empty state when only one filter is active', async () => {
    await renderGrid(['/projects/proj-1/grid?owner=r3']);
    expect(await screen.findByText('No tasks match these filters')).toBeInTheDocument();
    expect(screen.queryByText(/Each filter has rows on its own/)).not.toBeInTheDocument();
  });
});

describe('GridView — no project in scope', () => {
  beforeEach(() => {
    projectIdMock = undefined;
    projectMethodology = 'AGILE'; // flat
    projectAgileFeatures = false;
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    labelsMock = [
      { id: 'l1', name: 'Needs review', color: 'teal', position: 0, serverVersion: 1, taskCount: 0 },
    ];
    useTaskDrawerStore.setState({ task: null, projectId: null });
  });

  it('uses the methodology default and persists nothing when there is no project', async () => {
    const user = userEvent.setup();
    await renderGrid();
    // AGILE ⇒ flat, straight from methodologyDefaultMode (no localStorage read).
    expect(await screen.findByRole('grid', { name: /task list/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Outline tree' }));
    expect(await screen.findByRole('treegrid', { name: /outline task tree/i })).toBeInTheDocument();
    // The mode change is honored in-session but never written to storage — there
    // is no project key to write it under.
    expect(window.localStorage.length).toBe(0);
  });

  it('does not persist a group-by change when there is no project', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(screen.getByRole('button', { name: 'Grouped' }));
    await user.selectOptions(await screen.findByLabelText(/group by dimension/i), 'status');
    expect(await screen.findByText('Grouped by status.')).toBeInTheDocument();
    expect(window.localStorage.length).toBe(0);
  });

  it('does not open the task drawer on a row activation without a project', async () => {
    await renderGrid();
    const row = await screen.findByRole('row', { name: 'Open details for Design' });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(useTaskDrawerStore.getState().task).toBeNull();
  });

  it('ignores a ?task= deep link when there is no project', async () => {
    await renderGrid(['/grid?task=t2']);
    await screen.findByRole('grid', { name: /task list/i });
    expect(useTaskDrawerStore.getState().task).toBeNull();
  });

  it('exports CSV under a generic filename when there is no project', async () => {
    const user = userEvent.setup();
    exportTasksToCsv.mockClear();
    await renderGrid();
    await user.click(await screen.findByRole('button', { name: /export tasks as csv/i }));
    expect(exportTasksToCsv).toHaveBeenCalledWith(expect.any(Array), 'tasks-export.csv');
  });

  it('offers no label-settings shortcut without a project to route to', async () => {
    labelsMock = [];
    const user = userEvent.setup();
    await renderGrid();
    await user.click(await screen.findByRole('button', { name: 'Label: none yet' }));
    expect(screen.getByText('No labels in this project yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open label settings' })).not.toBeInTheDocument();
  });

  it('never enters the delete confirm flow without a project', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(await screen.findByLabelText('Select Design'));
    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    // handleDeleteClick bails on the missing project, so the confirm strip that
    // would 404 on submit never replaces the toolbar.
    expect(screen.queryByRole('alertdialog', { name: /confirm deletion/i })).not.toBeInTheDocument();
  });
});

describe('GridView — project not yet loaded', () => {
  beforeEach(() => {
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    projectMethodology = 'AGILE';
    projectAgileFeatures = true;
  });

  it('falls back to the HYBRID default (outline, no Sprint grouping) before the project resolves', async () => {
    const user = userEvent.setup();
    projectDataUndefined = true;
    await renderGrid();
    // methodology ?? 'HYBRID' ⇒ outline, even though the mock's methodology is AGILE.
    expect(await screen.findByRole('treegrid', { name: /outline task tree/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Grouped' }));
    const select = await screen.findByLabelText(/group by dimension/i);
    // agile_features === true is unknowable without the project, so Sprint is withheld.
    expect(within(select).queryByRole('option', { name: /sprint/i })).not.toBeInTheDocument();
  });
});

describe('GridView — facet catalogs not yet resolved', () => {
  beforeEach(() => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
  });

  it('renders empty facet catalogs rather than throwing when neither query has resolved', async () => {
    labelsMock = undefined;
    resourcePoolMock = undefined;
    await renderGrid();
    expect(await screen.findByRole('button', { name: 'Label: none yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Owner: none yet' })).toBeInTheDocument();
    // Rows still render — an unresolved catalog is not a filter.
    expect(screen.getByText('Planning')).toBeInTheDocument();
  });
});

describe('GridView — mobile facet presentation', () => {
  interface FakeMql {
    matches: boolean;
    media: string;
    onchange: null;
    addListener: () => void;
    removeListener: () => void;
    addEventListener: (type: string, cb: (e: MediaQueryListEvent) => void) => void;
    removeEventListener: () => void;
    dispatchEvent: () => boolean;
  }

  /** Fake `matchMedia` whose `(max-width: …)` answer is flippable at runtime. */
  function installMatchMedia(startMobile: boolean) {
    const listeners: ((e: MediaQueryListEvent) => void)[] = [];
    let mobile = startMobile;
    vi.stubGlobal(
      'matchMedia',
      (query: string): FakeMql => ({
        matches: /^\(max-width:/.test(query) ? mobile : /^\(min-width:/.test(query),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: (_type, cb) => {
          listeners.push(cb);
        },
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    );
    return (next: boolean) => {
      mobile = next;
      act(() => {
        listeners.forEach((cb) => cb({ matches: next } as MediaQueryListEvent));
      });
    };
  }

  beforeEach(() => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the facets as bottom sheets below the md breakpoint', async () => {
    installMatchMedia(true);
    await renderGrid();
    // presentation="sheet" ⇒ the trigger advertises a dialog, not a menu.
    expect(await screen.findByRole('button', { name: 'Owner: any' })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
    expect(screen.getByRole('button', { name: 'Status: any' })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
  });

  it('reverts to popovers when the viewport widens past the breakpoint', async () => {
    const setMobile = installMatchMedia(true);
    await renderGrid();
    const trigger = await screen.findByRole('button', { name: 'Owner: any' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    setMobile(false);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Owner: any' })).toHaveAttribute(
        'aria-haspopup',
        'menu',
      ),
    );
  });
});

describe('GridView — toast dwell (#2078)', () => {
  beforeEach(() => {
    projectMethodology = 'AGILE'; // flat — where bulk delete lives
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    bulkDeleteMutate.mockReset();
    bulkRestoreMutate.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the undoable delete toast for its longer dwell, then dismisses it', async () => {
    bulkDeleteMutate.mockImplementation((_ids: string[], opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });
    await renderGrid();
    const box = await screen.findByLabelText('Select Design');
    vi.useFakeTimers();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }));
    // Exactly one row selected ⇒ singular copy.
    expect(screen.getByText(/^1 task deleted\.$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^undo$/i })).toBeInTheDocument();
    // Still up at 4s — the Undo affordance earns the longer dwell.
    act(() => {
      vi.advanceTimersByTime(4_500);
    });
    expect(screen.getByText(/^1 task deleted\.$/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(screen.queryByText(/^1 task deleted\.$/)).not.toBeInTheDocument();
  });

  it('dismisses the plain failure toast after the shorter dwell', async () => {
    bulkDeleteMutate.mockImplementation((_ids: string[], opts?: { onError?: () => void }) => {
      opts?.onError?.();
    });
    await renderGrid();
    const box = await screen.findByLabelText('Select Design');
    vi.useFakeTimers();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }));
    const failure = screen.getByRole('alert');
    expect(failure).toHaveTextContent("Couldn't delete tasks — try again.");
    // No Undo on a failure, so it gets the 4s dwell rather than 8s.
    act(() => {
      vi.advanceTimersByTime(4_500);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('GridView — select-all toggle', () => {
  beforeEach(() => {
    projectMethodology = 'AGILE'; // flat
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
  });

  it('selects every row, then clears the selection on a second click', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(await screen.findByLabelText('Select all tasks'));
    expect(await screen.findByText('3 selected')).toBeInTheDocument();
    // Second click hits the already-all-selected branch and clears instead.
    await user.click(screen.getByLabelText('Deselect all tasks'));
    await waitFor(() => expect(screen.queryByText('3 selected')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Select all tasks')).toBeInTheDocument();
  });
});

describe('GridView — singular announcement', () => {
  beforeEach(() => {
    projectMethodology = 'HYBRID'; // starts outline so the flat switch is a change
    scheduleTasksMockReturn = { tasks: [mockTasks[2]], links: [], isLoading: false, error: null };
  });

  it('announces "1 task shown" (not "1 tasks") for a single-row project', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(await screen.findByRole('button', { name: 'Flat list' }));
    expect(await screen.findByText('Switched to flat mode. 1 task shown.')).toBeInTheDocument();
  });
});

describe('GridView — loading skeleton shape', () => {
  it('indents the skeleton rows while the outline mode is loading', async () => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: null, links: [], isLoading: true, error: null };
    await renderGrid();
    const busy = document.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    const rows = Array.from((busy as HTMLElement).children) as HTMLElement[];
    expect(rows).toHaveLength(10);
    // Outline previews the hierarchy: rows step 0 / 16 / 32px and repeat.
    expect(rows[0].style.marginLeft).toBe('0px');
    expect(rows[1].style.marginLeft).toBe('16px');
    expect(rows[2].style.marginLeft).toBe('32px');
  });

  it('leaves the skeleton rows flush while the flat mode is loading', async () => {
    projectMethodology = 'AGILE';
    scheduleTasksMockReturn = { tasks: null, links: [], isLoading: true, error: null };
    await renderGrid();
    const rows = Array.from(
      (document.querySelector('[aria-busy="true"]') as HTMLElement).children,
    ) as HTMLElement[];
    expect(rows.every((r) => r.style.marginLeft === '' || r.style.marginLeft === '0px')).toBe(true);
  });
});

describe('GridView — facet panel dismissal', () => {
  beforeEach(() => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    labelsMock = [
      { id: 'l1', name: 'Needs review', color: 'teal', position: 0, serverVersion: 1, taskCount: 0 },
    ];
  });

  it('Escape closes the Status panel and leaves no facet open', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(await screen.findByRole('button', { name: 'Status: any' }));
    expect(screen.getByRole('menu', { name: 'Filter by status' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Filter by status' })).not.toBeInTheDocument(),
    );
  });

  it('Escape closes the Label panel and leaves no facet open', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(await screen.findByRole('button', { name: 'Label: any' }));
    expect(screen.getByRole('menu', { name: 'Filter by label' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Filter by label' })).not.toBeInTheDocument(),
    );
  });
});

describe('GridView — offline filtering note', () => {
  beforeEach(() => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it('says filtering is limited to the loaded rows while offline with a facet active', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await renderGrid(['/projects/proj-1/grid?owner=r1']);
    expect(
      await screen.findByText('Offline — filtering the 3 rows already loaded'),
    ).toBeInTheDocument();
  });

  it('shows no offline note when a facet is active but the browser is online', async () => {
    await renderGrid(['/projects/proj-1/grid?owner=r1']);
    await screen.findByLabelText('Remove Owner: Alice Smith filter');
    expect(screen.queryByText(/Offline — filtering/)).not.toBeInTheDocument();
  });

  it('shows no offline note when offline with no facet filter active', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await renderGrid();
    await screen.findByRole('button', { name: 'Owner: any' });
    expect(screen.queryByText(/Offline — filtering/)).not.toBeInTheDocument();
  });
});

describe('GridView — empty-project toolbar', () => {
  beforeEach(() => {
    scheduleTasksMockReturn = { tasks: [], links: [], isLoading: false, error: null };
  });

  it('keeps the expand/collapse controls inert on an empty outline project', async () => {
    const user = userEvent.setup();
    projectMethodology = 'HYBRID';
    await renderGrid();
    await user.click(await screen.findByRole('button', { name: 'Expand all' }));
    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    // Nothing to expand — the empty state stays put rather than erroring.
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
  });

  it('keeps select-all inert and CSV disabled on an empty flat project', async () => {
    const user = userEvent.setup();
    projectMethodology = 'AGILE';
    await renderGrid();
    const selectAll = await screen.findByLabelText('Select all tasks');
    await user.click(selectAll);
    expect(screen.getByLabelText('Select all tasks')).toBeInTheDocument();
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export tasks as csv/i })).toBeDisabled();
    expect(screen.getByText('0 / 0 shown')).toBeInTheDocument();
  });

  it('opens and closes the create modal from the empty-project toolbar', async () => {
    const user = userEvent.setup();
    projectMethodology = 'AGILE';
    await renderGrid();
    await user.click(await screen.findByRole('button', { name: /^\+ task$/i }));
    const dialog = await screen.findByRole('dialog', { name: /task form/i });
    // Toolbar "+ Task" creates a root task — no parent.
    expect(within(dialog).getByTestId('parent-id')).toHaveTextContent('none');
    await user.click(within(dialog).getByRole('button', { name: /close form/i }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /task form/i })).not.toBeInTheDocument(),
    );
  });
});

describe('GridView — label chip and settings route', () => {
  beforeEach(() => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    labelsMock = [
      { id: 'l1', name: 'Needs review', color: 'teal', position: 0, serverVersion: 1, taskCount: 0 },
      { id: 'l2', name: 'Blocked', color: 'rose', position: 1, serverVersion: 1, taskCount: 0 },
    ];
  });

  it('removing a label chip clears that label from the filter and the URL', async () => {
    const user = userEvent.setup();
    const { search } = await renderGridWithRouter(['/projects/proj-1/grid?fl=l1,l2']);
    await user.click(
      await screen.findByRole('button', { name: 'Remove filter: label Needs review' }),
    );
    // Only the clicked label leaves; the other stays selected.
    await waitFor(() => expect(search()).toContain('fl=l2'));
    expect(
      screen.queryByRole('button', { name: 'Remove filter: label Needs review' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove filter: label Blocked' })).toBeInTheDocument();
  });

  it('announces the plural label count once the selection settles', async () => {
    await renderGrid(['/projects/proj-1/grid?fl=l1,l2']);
    // Debounced (600ms) so a burst of toggles reads once, as a shape: "2 labels".
    expect(await screen.findByText(/0 of 3 rows — 2 labels/, undefined, { timeout: 3000 })).toBeInTheDocument();
  });

  it('routes to label settings from the empty label panel', async () => {
    labelsMock = [];
    const user = userEvent.setup();
    const { pathname } = await renderGridWithRouter(['/projects/proj-1/grid']);
    await user.click(await screen.findByRole('button', { name: 'Label: none yet' }));
    await user.click(screen.getByRole('button', { name: 'Open label settings' }));
    await waitFor(() => expect(pathname()).toBe('/projects/proj-1/settings/labels'));
  });
});

describe('GridView — zero-result diagnosis drops (#2387)', () => {
  // Same rows, but finishing in the future so none of them is overdue — that lets
  // the Overdue facet be the one whose removal recovers the most rows.
  const futureTasks: Task[] = mockTasks.map((t) => ({
    ...t,
    start: '2099-05-01',
    finish: '2099-05-10',
  }));

  beforeEach(() => {
    projectMethodology = 'HYBRID';
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    labelsMock = [
      { id: 'l1', name: 'Needs review', color: 'teal', position: 0, serverVersion: 1, taskCount: 0 },
    ];
  });

  it('summarizes a multi-value facet as "first +N" and drops the search that recovers most', async () => {
    const user = userEvent.setup();
    await renderGrid(['/projects/proj-1/grid?q=zzz-no-match&owner=r1,r2']);
    const diagnosis = within(await screen.findByRole('status'));
    expect(diagnosis.getByText(/No tasks match both filters/)).toBeInTheDocument();
    // Two owners are compacted rather than listed in full.
    expect(diagnosis.getByText('Owner: Alice Smith +1')).toBeInTheDocument();
    // Dropping the search recovers the two owner rows; dropping the owners recovers none.
    await user.click(screen.getByRole('button', { name: 'Drop "zzz-no-match"' }));
    expect(await screen.findByText('Planning')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: /search tasks/i })).toHaveValue('');
  });

  it('drops the Status facet when that is the recovery worth offering', async () => {
    const user = userEvent.setup();
    await renderGrid(['/projects/proj-1/grid?owner=r1&status=NOT_STARTED']);
    expect(await screen.findByText(/No tasks match both filters/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Drop Status:/ }));
    // Alice's two rows come back; the status chip is gone.
    expect(await screen.findByText('Planning')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Remove Status: /)).not.toBeInTheDocument();
  });

  it('drops the Label facet when no loaded row carries the selected label', async () => {
    const user = userEvent.setup();
    await renderGrid(['/projects/proj-1/grid?owner=r1&fl=l1']);
    const diagnosis = within(await screen.findByRole('status'));
    expect(diagnosis.getByText(/No tasks match both filters/)).toBeInTheDocument();
    expect(diagnosis.getByText('Label: Needs review')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Drop Label: Needs review' }));
    expect(await screen.findByText('Planning')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Label: any' })).toBeInTheDocument();
  });

  it('drops the Overdue drill-down when nothing loaded is actually late', async () => {
    const user = userEvent.setup();
    scheduleTasksMockReturn = { tasks: futureTasks, links: [], isLoading: false, error: null };
    await renderGrid(['/projects/proj-1/grid?due=overdue&owner=r1']);
    const diagnosis = within(await screen.findByRole('status'));
    expect(diagnosis.getByText(/No tasks match both filters/)).toBeInTheDocument();
    expect(diagnosis.getByText('Overdue')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Drop Overdue' }));
    expect(await screen.findByText('Planning')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Remove Overdue filter/)).not.toBeInTheDocument();
  });
});

describe('GridView — ?task= effect after the deep link is consumed', () => {
  beforeEach(() => {
    projectMethodology = 'AGILE'; // flat
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    useTaskDrawerStore.setState({ task: null, projectId: null });
  });

  it('consumes the deep link exactly once, even when the task list re-resolves', async () => {
    const user = userEvent.setup();
    await renderGrid(['/projects/proj-1/grid?task=t2']);
    await waitFor(() => expect(useTaskDrawerStore.getState().task?.id).toBe('t2'));
    // Close the drawer, then hand the component a fresh tasks array (a refetch).
    act(() => useTaskDrawerStore.setState({ task: null, projectId: null }));
    scheduleTasksMockReturn = {
      tasks: [...mockTasks],
      links: [],
      isLoading: false,
      error: null,
    };
    await user.click(screen.getByRole('button', { name: 'Grouped' }));
    // The one-shot ref holds: the refetch does not re-open the drawer the user closed.
    expect(useTaskDrawerStore.getState().task).toBeNull();
  });
});

describe('GridView — row click-through to the drawer', () => {
  beforeEach(() => {
    projectMethodology = 'AGILE'; // flat rows carry onOpenDetail
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    useTaskDrawerStore.setState({ task: null, projectId: null });
  });

  it('opens the app-wide drawer on the clicked row, scoped to the project', async () => {
    await renderGrid();
    const row = await screen.findByRole('row', { name: 'Open details for Design' });
    fireEvent.keyDown(row, { key: 'Enter' });
    await waitFor(() => {
      const open = useTaskDrawerStore.getState();
      expect(open.task?.id).toBe('t3');
      expect(open.projectId).toBe('proj-1');
    });
  });
});

describe('GridView — singular undo copy (#2078)', () => {
  beforeEach(() => {
    projectMethodology = 'AGILE'; // flat
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
    bulkDeleteMutate.mockReset();
    bulkRestoreMutate.mockReset();
    bulkDeleteMutate.mockImplementation((_ids: string[], opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });
    bulkRestoreMutate.mockImplementation((_ids: string[], opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });
  });

  it('says "1 task restored" — not "1 tasks" — when a single row is undone', async () => {
    const user = userEvent.setup();
    await renderGrid();
    await user.click(await screen.findByLabelText('Select Design'));
    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    await user.click(await screen.findByRole('button', { name: /confirm delete/i }));
    await user.click(await screen.findByRole('button', { name: /^undo$/i }));
    expect(await screen.findByText('1 task restored.')).toBeInTheDocument();
    expect(bulkRestoreMutate).toHaveBeenCalledWith(['t3'], expect.anything());
  });
});
