import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, links: [], isLoading: false, error: null }),
}));

vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useSprints', () => ({
  useSprints: () => ({ sprints: [{ id: 's1', name: 'Sprint 5' }], isLoading: false, error: null }),
}));

vi.mock('@/stores/taskSelectionStore', () => ({
  useTaskSelectionStore: () => ({
    selectedIds: new Set<string>(),
    toggle: vi.fn(),
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

function renderGrouped(groupBy: Parameters<typeof GroupedMode>[0]['groupBy'] = 'phase') {
  return render(
    <GroupedMode groupBy={groupBy} filters={emptyFilters()} onClearFilters={vi.fn()} />,
  );
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
        filters={{ search: 'no-match', ownerFilter: '', statusFilter: '', dueFilter: 'all' as const }}
        onClearFilters={vi.fn()}
      />,
    );
    expect(screen.getByText(/no tasks match these filters/i)).toBeInTheDocument();
  });

  it('clicking a column header toggles sort direction', () => {
    renderGrouped('phase');
    const wbsHeader = screen.getByRole('columnheader', { name: /^WBS$/i });
    fireEvent.click(wbsHeader.querySelector('button')!);
    expect(wbsHeader).toHaveAttribute('aria-sort', 'descending');
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

  it('double-click on a leaf row enters rename mode and Enter commits', () => {
    renderGrouped('phase');
    // Pick the row for 'Discover' (a leaf) — double-click on a summary is a no-op.
    const discoverRow = screen.getByLabelText('Select Discover').closest('[role="row"]') as HTMLElement;
    fireEvent.doubleClick(discoverRow);
    const input = screen.getByLabelText('Rename task');
    expect(input).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // After Enter, the input is removed from the DOM (handleRename clears renamingId).
    expect(screen.queryByLabelText('Rename task')).not.toBeInTheDocument();
  });
});
