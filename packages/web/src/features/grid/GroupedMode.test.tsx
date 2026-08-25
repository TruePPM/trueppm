import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GroupedMode } from './GroupedMode';
import { emptyFilters } from './filters';
import type { Task } from '@/types';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return this; } };
    },
  });
});

const mockTasks: Task[] = [
  {
    id: 'p1', wbs: '1', name: 'Phase 1', start: '2026-05-01', finish: '2026-05-30',
    duration: 30, progress: 0, parentId: null,
    isCritical: false, isComplete: false, isSummary: true, isMilestone: false,
    status: 'IN_PROGRESS', assignees: [], notes: '',
  },
  {
    id: 't1', wbs: '1.1', name: 'Discover', start: '2026-05-01', finish: '2026-05-05',
    duration: 4, progress: 100, parentId: 'p1', sprintId: 's1',
    isCritical: false, isComplete: true, isSummary: false, isMilestone: false,
    status: 'COMPLETE', assignees: [{ resourceId: 'r1', name: 'Alice', units: 100 }], notes: '',
  },
  {
    id: 't2', wbs: '1.2', name: 'Build', start: '2026-05-06', finish: '2026-05-15',
    duration: 9, progress: 25, parentId: 'p1',
    isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
    status: 'NOT_STARTED', assignees: [], notes: '',
  },
  {
    id: 't3', wbs: '1.3', name: 'Review', start: '2026-05-16', finish: '2026-05-20',
    duration: 4, progress: 0, parentId: 'p1',
    isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [
      { resourceId: 'r1', name: 'Alice', units: 50 },
      { resourceId: 'r2', name: 'Bob', units: 50 },
    ], notes: '',
  },
];

interface SprintStub {
  id: string;
  name: string;
}

/**
 * Mutable hook state so each case can drive the component's guards from both
 * sides (no project in context, a schedule that has not resolved yet, a sprint
 * id the sprint list does not know about).
 */
const hookState: {
  tasks: Task[] | undefined;
  projectId: string | undefined;
  sprints: SprintStub[];
} = {
  tasks: mockTasks,
  projectId: 'proj-1',
  sprints: [{ id: 's1', name: 'Sprint 5' }],
};

const updateMutate = vi.fn();
const toggleSelect = vi.fn();
const useSprintsSpy = vi.fn<(projectId?: string) => { sprints: SprintStub[] }>();

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => hookState.projectId }));

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: hookState.tasks, links: [], isLoading: false, error: null }),
}));

vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate: updateMutate, isPending: false }),
}));

vi.mock('@/hooks/useSprints', () => ({
  useSprints: (projectId?: string) => {
    useSprintsSpy(projectId);
    return { sprints: hookState.sprints, isLoading: false, error: null };
  },
}));

vi.mock('@/stores/taskSelectionStore', () => ({
  useTaskSelectionStore: () => ({
    selectedIds: new Set<string>(),
    toggle: toggleSelect,
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
  }),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (i: number) => number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index, key: index,
      start: index * estimateSize(index),
      size: estimateSize(index),
      end: (index + 1) * estimateSize(index),
      lane: 0,
    })),
    getTotalSize: () => count * 44,
  }),
}));

beforeEach(() => {
  hookState.tasks = mockTasks;
  hookState.projectId = 'proj-1';
  hookState.sprints = [{ id: 's1', name: 'Sprint 5' }];
  updateMutate.mockReset();
  toggleSelect.mockReset();
  useSprintsSpy.mockReset();
});

function renderGrouped(
  groupBy: Parameters<typeof GroupedMode>[0]['groupBy'] = 'phase',
  props: Partial<Parameters<typeof GroupedMode>[0]> = {},
) {
  return render(
    <GroupedMode groupBy={groupBy} filters={emptyFilters()} onClearFilters={vi.fn()} {...props} />,
  );
}

/** Enter rename mode on a leaf row and return its input. */
function startRename(taskName: string): HTMLInputElement {
  const row = screen.getByLabelText(`Select ${taskName}`).closest('[role="row"]') as HTMLElement;
  fireEvent.doubleClick(row);
  return screen.getByLabelText<HTMLInputElement>('Rename item');
}

describe('GroupedMode — group key resolution', () => {
  it('groups by phase: leaves under their summary, summary under itself', () => {
    renderGrouped('phase');
    expect(screen.getAllByText('Phase 1').length).toBeGreaterThan(0);
  });

  it('groups by owner: tasks under their first assignee', () => {
    renderGrouped('owner');
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  it('groups by status: tasks bucketed by status label', () => {
    renderGrouped('status');
    // Status labels also appear inside task-row status pills, so use getAllByText.
    expect(screen.getAllByText('Done').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not started').length).toBeGreaterThan(0);
    expect(screen.getAllByText('In progress').length).toBeGreaterThan(0);
  });

  it('groups by sprint: tasks under sprint name; sprintless tasks fall under Backlog', () => {
    renderGrouped('sprint');
    expect(screen.getByText('Sprint 5')).toBeInTheDocument();
    expect(screen.getByText('Backlog')).toBeInTheDocument();
  });

  it('groups a task whose sprint is not in the sprint list under "Unknown sprint"', () => {
    // The sprint list resolved without the task's sprint (deleted sprint, or a
    // list that has not refetched) — the row must still land in a bucket.
    hookState.sprints = [];
    renderGrouped('sprint');
    expect(screen.getByText('Unknown sprint')).toBeInTheDocument();
    expect(screen.queryByText('Sprint 5')).not.toBeInTheDocument();
    expect(screen.getByText('Backlog')).toBeInTheDocument();
  });

  it('groups by resource: multi-assignee task duplicates across resource groups', () => {
    renderGrouped('resource');
    // Alice appears as a group header (resource group). 'Review' has both Alice and Bob.
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    // Review (multi-assignee) appears under each resource — at least 2 occurrences.
    expect(screen.getAllByText('Review').length).toBeGreaterThanOrEqual(2);
  });

  it('renders the filtered-empty state when no tasks match', () => {
    render(
      <GroupedMode
        groupBy="phase"
        filters={{ search: 'no-match', ownerIds: [], statuses: [], dueFilter: 'all', labelIds: [] as const }}
        onClearFilters={vi.fn()}
      />,
    );
    expect(screen.getByText(/no tasks match these filters/i)).toBeInTheDocument();
  });

  it('renders the caller-supplied empty state instead of the default when provided', () => {
    render(
      <GroupedMode
        groupBy="phase"
        filters={{ search: 'no-match', ownerIds: [], statuses: [], dueFilter: 'all', labelIds: [] as const }}
        onClearFilters={vi.fn()}
        filteredEmptyState={<p>Two facets are fighting</p>}
      />,
    );
    expect(screen.getByText('Two facets are fighting')).toBeInTheDocument();
    expect(screen.queryByText(/no tasks match these filters/i)).not.toBeInTheDocument();
  });

  it('renders the empty state (not a grid) while the schedule has not resolved', () => {
    // `useScheduleTasks` returns undefined before the first fetch settles.
    hookState.tasks = undefined;
    renderGrouped('phase');
    expect(screen.getByText(/no tasks match these filters/i)).toBeInTheDocument();
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });

  it('exposes an aria-rowcount covering group headers and task rows', () => {
    renderGrouped('owner');
    const grid = screen.getByRole('grid', { name: 'Item list' });
    // 2 owner groups (Alice, Unassigned) + 4 task rows.
    expect(grid).toHaveAttribute('aria-rowcount', '6');
  });
});

describe('GroupedMode — column header sorting', () => {
  it('clicking a column header toggles sort direction', () => {
    renderGrouped('phase');
    const wbsHeader = screen.getByRole('columnheader', { name: /^WBS$/i });
    fireEvent.click(wbsHeader.querySelector('button')!);
    expect(wbsHeader).toHaveAttribute('aria-sort', 'descending');
  });

  it('clicking the active column a second time flips back to ascending', () => {
    renderGrouped('phase');
    const wbsHeader = screen.getByRole('columnheader', { name: /^WBS$/i });
    const button = wbsHeader.querySelector('button')!;
    fireEvent.click(button);
    expect(wbsHeader).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(button);
    expect(wbsHeader).toHaveAttribute('aria-sort', 'ascending');
  });

  it('switching to a different column resets the direction to ascending', () => {
    renderGrouped('phase');
    const wbsHeader = screen.getByRole('columnheader', { name: /^WBS$/i });
    const nameHeader = screen.getByRole('columnheader', { name: /^Name$/i });
    fireEvent.click(wbsHeader.querySelector('button')!);
    expect(wbsHeader).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(nameHeader.querySelector('button')!);
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
    // The previously sorted column relinquishes its indicator.
    expect(wbsHeader).toHaveAttribute('aria-sort', 'none');
  });

  it('Enter on a column header button activates sort via keyboard', () => {
    renderGrouped('phase');
    const nameHeader = screen.getByRole('columnheader', { name: /^Name$/i });
    fireEvent.keyDown(nameHeader.querySelector('button')!, { key: 'Enter' });
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
  });

  it('Space on a column header button also activates sort', () => {
    renderGrouped('phase');
    const nameHeader = screen.getByRole('columnheader', { name: /^Name$/i });
    fireEvent.keyDown(nameHeader.querySelector('button')!, { key: ' ' });
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
  });

  it('an unrelated key on a column header does not sort', () => {
    renderGrouped('phase');
    const nameHeader = screen.getByRole('columnheader', { name: /^Name$/i });
    fireEvent.keyDown(nameHeader.querySelector('button')!, { key: 'a' });
    expect(nameHeader).toHaveAttribute('aria-sort', 'none');
  });

  it('non-sortable columns expose no sort control', () => {
    renderGrouped('phase');
    const owner = screen.getByRole('columnheader', { name: /^Owner$/i });
    expect(owner.querySelector('button')).toBeNull();
  });
});

describe('GroupedMode — rename', () => {
  it('double-click on a leaf row enters rename mode and Enter commits', () => {
    renderGrouped('phase');
    const input = startRename('Discover');
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // After Enter, the input is removed from the DOM (handleRename clears renamingId).
    expect(screen.queryByLabelText('Rename item')).not.toBeInTheDocument();
    expect(updateMutate).toHaveBeenCalledWith({
      id: 't1',
      projectId: 'proj-1',
      name: 'New name',
    });
  });

  it('trims the committed name before writing it', () => {
    renderGrouped('phase');
    const input = startRename('Discover');
    fireEvent.change(input, { target: { value: '  Padded  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Padded' }),
    );
  });

  it('does not write when the name is unchanged', () => {
    renderGrouped('phase');
    const input = startRename('Discover');
    // Commit without editing — the input is seeded with the current name.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByLabelText('Rename item')).not.toBeInTheDocument();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('does not write when the name is blanked out', () => {
    renderGrouped('phase');
    const input = startRename('Discover');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByLabelText('Rename item')).not.toBeInTheDocument();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('Escape cancels the rename without writing', () => {
    renderGrouped('phase');
    const input = startRename('Discover');
    fireEvent.change(input, { target: { value: 'Abandoned' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByLabelText('Rename item')).not.toBeInTheDocument();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('does not write a rename when there is no project in context', () => {
    // No project route param — the update mutation has no project to target,
    // so the rename closes without a write rather than firing a bad request.
    hookState.projectId = undefined;
    renderGrouped('phase');
    const input = startRename('Discover');
    fireEvent.change(input, { target: { value: 'Orphan rename' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByLabelText('Rename item')).not.toBeInTheDocument();
    expect(updateMutate).not.toHaveBeenCalled();
    // The sprint list is likewise queried with no project id.
    expect(useSprintsSpy).toHaveBeenCalledWith(undefined);
  });

  it('queries sprints for the project in context', () => {
    renderGrouped('sprint');
    expect(useSprintsSpy).toHaveBeenCalledWith('proj-1');
  });

  it('double-click on a summary row does not start a rename', () => {
    renderGrouped('phase');
    const summaryRow = screen
      .getByLabelText('Select Phase 1')
      .closest('[role="row"]') as HTMLElement;
    fireEvent.doubleClick(summaryRow);
    expect(screen.queryByLabelText('Rename item')).not.toBeInTheDocument();
  });
});

describe('GroupedMode — selection and detail', () => {
  it('toggling a row checkbox reports the task id to the selection store', () => {
    renderGrouped('phase');
    fireEvent.click(screen.getByLabelText('Select Discover'));
    expect(toggleSelect).toHaveBeenCalledWith('t1');
  });

  it('hides the per-row select checkbox for a read-only viewer', () => {
    renderGrouped('phase', { canEdit: false });
    expect(screen.queryByLabelText('Select Discover')).not.toBeInTheDocument();
    // The rows themselves still render.
    expect(screen.getAllByText('Discover').length).toBeGreaterThan(0);
  });

  it('opens the detail drawer for the clicked task when a handler is supplied', () => {
    vi.useFakeTimers();
    try {
      const onOpenDetail = vi.fn<(task: Task) => void>();
      renderGrouped('phase', { onOpenDetail });
      const row = screen.getByLabelText('Open details for Discover');
      fireEvent.click(row);
      // The row debounces the open so a double-click can win the race instead.
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves rows inert when no detail handler is supplied', () => {
    renderGrouped('phase');
    expect(screen.queryByLabelText('Open details for Discover')).not.toBeInTheDocument();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

describe('GroupedMode — the vocabulary lock (#3052)', () => {
  it('names the outline "Item list", never "Task list"', () => {
    // Both directions on purpose: asserting only the new name would still pass
    // if the old one came back beside it, which is how a rename half-lands.
    renderGrouped();
    expect(screen.getByRole('grid', { name: 'Item list' })).toBeInTheDocument();
    expect(screen.queryByRole('grid', { name: 'Task list' })).toBeNull();
  });

  it('names the rename input "Rename item", never "Rename task"', () => {
    // A rename input sits on a row whose type is exactly as undeclared as it
    // was when the row was created — the noun cannot harden between creating a
    // row and renaming it.
    renderGrouped();
    startRename('Discover');
    expect(screen.getByLabelText('Rename item')).toBeInTheDocument();
    expect(screen.queryByLabelText('Rename task')).toBeNull();
  });
});
