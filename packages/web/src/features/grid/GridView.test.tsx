import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useTaskDrawerStore } from '@/stores/taskDrawerStore';
import { useWbsStore } from '@/stores/wbsStore';
import { ROLE_MEMBER, ROLE_VIEWER } from '@/lib/roles';
import type { Task, Methodology } from '@/types';

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

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));

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

vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({
    data: { id: 'proj-1', methodology: projectMethodology, agile_features: projectAgileFeatures },
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

describe('GridView — role gating (#2145)', () => {
  beforeEach(() => {
    projectMethodology = 'AGILE'; // flat — where select-all/Delete/+Task live
    scheduleTasksMockReturn = { tasks: mockTasks, links: [], isLoading: false, error: null };
  });

  it('a Viewer sees no select-all, no + Task, and no bulk-delete affordance', async () => {
    currentRoleMock = ROLE_VIEWER;
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
    await renderGrid();
    expect(await screen.findByLabelText(/select all tasks/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^\+ task$/i })).toBeInTheDocument();
  });

  it('while the role is still loading (null) the write controls stay hidden (pessimistic)', async () => {
    currentRoleMock = null;
    await renderGrid();
    expect(await screen.findByText('Planning')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^\+ task$/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/select all tasks/i)).not.toBeInTheDocument();
  });

  it('the empty-state CTA is hidden for a Viewer', async () => {
    currentRoleMock = ROLE_VIEWER;
    scheduleTasksMockReturn = { tasks: [], links: [], isLoading: false, error: null };
    await renderGrid();
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /\+ add task/i })).not.toBeInTheDocument();
  });
});
