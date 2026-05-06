import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import type { Task, Methodology } from '@/types';

// JSDOM has no layout — TanStack Virtual relies on getBoundingClientRect for
// the scroll container. Stub a non-zero height so virtualised rows render.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return this; } };
    },
  });
  // Reset persistence between tests so each test starts at the methodology default.
  window.localStorage.clear();
});

const mockTasks: Task[] = [
  {
    id: 't1', wbs: '1', name: 'Planning', start: '2026-05-01', finish: '2026-05-10',
    duration: 10, progress: 50, parentId: null,
    isCritical: false, isComplete: false, isSummary: true, isMilestone: false,
    status: 'IN_PROGRESS', assignees: [{ resourceId: 'r1', name: 'Alice Smith', units: 100 }],
  },
  {
    id: 't2', wbs: '1.1', name: 'Requirements', start: '2026-05-01', finish: '2026-05-05',
    duration: 5, progress: 100, parentId: 't1',
    isCritical: true, isComplete: true, isSummary: false, isMilestone: false,
    status: 'COMPLETE', assignees: [
      { resourceId: 'r1', name: 'Alice Smith', units: 100 },
      { resourceId: 'r2', name: 'Bob Jones', units: 50 },
    ],
  },
  {
    id: 't3', wbs: '2', name: 'Design', start: '2026-05-11', finish: '2026-05-20',
    duration: 10, progress: 0, parentId: null,
    isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
    status: 'NOT_STARTED', assignees: [{ resourceId: 'r2', name: 'Bob Jones', units: 100 }],
  },
];

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));

let scheduleTasksMockReturn: { tasks: typeof mockTasks | null; links: never[]; isLoading: boolean; error: unknown } =
  { tasks: mockTasks, links: [], isLoading: false, error: null };

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

const bulkDeleteMutate = vi.fn();
vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate: vi.fn(), isPending: false }),
  useBulkDeleteTasks: () => ({ mutate: bulkDeleteMutate, isPending: false }),
  useReorderTasks: () => ({ mutate: vi.fn(), isPending: false }),
  useIndentTask: () => ({ mutate: vi.fn(), isPending: false }),
  useOutdentTask: () => ({ mutate: vi.fn(), isPending: false }),
  useReparentTask: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useSprints', () => ({
  useSprints: () => ({ sprints: [{ id: 's1', name: 'Sprint 1', state: 'ACTIVE' }], isLoading: false, error: null }),
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
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (i: number) => number }) => {
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

async function renderGrid() {
  const { GridView } = await import('./GridView');
  return renderWithRouter(<GridView />);
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
    const region = await screen.findByRole('generic', { hidden: true }, { timeout: 1000 }).catch(() => null);
    // The skeleton uses aria-busy on its container; assert that instead.
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(region ?? document.body).toBeTruthy();
  });

  it('shows error state with retry on fetch failure', async () => {
    scheduleTasksMockReturn = { tasks: null, links: [], isLoading: false, error: new Error('boom') };
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
    expect(exportTasksToCsv).toHaveBeenCalledWith(expect.any(Array), expect.stringContaining('proj-1'));
  });
});
