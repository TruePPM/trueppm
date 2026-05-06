import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlatMode } from './FlatMode';
import { emptyFilters } from './filters';
import type { Task } from '@/types';

const updateMutate = vi.fn();

beforeEach(() => {
  // JSDOM has no layout; stub a non-zero size so the virtualizer renders rows.
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return this; } };
    },
  });
});

const mockTasks: Task[] = [
  {
    id: 't2', wbs: '2', name: 'Build', start: '2026-05-11', finish: '2026-05-20',
    duration: 9, progress: 25, parentId: null,
    isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
    status: 'NOT_STARTED', assignees: [{ resourceId: 'r1', name: 'Alice', units: 100 }],
  },
  {
    id: 't1', wbs: '1', name: 'Discover', start: '2026-05-01', finish: '2026-05-05',
    duration: 4, progress: 100, parentId: null,
    isCritical: false, isComplete: true, isSummary: false, isMilestone: false,
    status: 'COMPLETE', assignees: [{ resourceId: 'r2', name: 'Bob', units: 100 }],
  },
];

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, links: [], isLoading: false, error: null }),
}));

vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate: updateMutate, isPending: false }),
}));

vi.mock('@/stores/taskSelectionStore', () => ({
  useTaskSelectionStore: () => ({
    selectedIds: new Set<string>(),
    toggle: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
  }),
}));

// Render every virtual row inline so DOM-order assertions work without measuring.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (i: number) => number }) => {
    const items = Array.from({ length: count }, (_, index) => ({
      index, key: index,
      start: index * estimateSize(index),
      size: estimateSize(index),
      end: (index + 1) * estimateSize(index),
      lane: 0,
    }));
    let totalSize = 0;
    for (let i = 0; i < count; i++) totalSize += estimateSize(i);
    return { getVirtualItems: () => items, getTotalSize: () => totalSize };
  },
}));

function renderFlat() {
  return render(<FlatMode filters={emptyFilters()} onClearFilters={vi.fn()} />);
}

describe('FlatMode — sortable column headers', () => {
  it('default order is by WBS ascending', () => {
    renderFlat();
    const rows = screen.getAllByRole('row').filter((r) => r.querySelector('input[type="checkbox"]'));
    expect(rows[0]).toHaveTextContent('Discover');
    expect(rows[1]).toHaveTextContent('Build');
  });

  // For each non-default column, the first click switches to that column ascending.
  // 'WBS' is the default sort — clicking it toggles to descending.
  it.each([
    ['Name', 'Build'],   // alphabetical asc
    ['Start', 'Discover'], // earliest start
    ['Finish', 'Discover'], // earliest finish
    ['Dur', 'Discover'], // shortest duration first
    ['Progress', 'Build'],   // 25% < 100% asc
  ] as const)('clicking %s header sorts ascending by that column', (header, expectedFirstName) => {
    renderFlat();
    const headerBtn = screen.getByRole('columnheader', { name: new RegExp(`^${header}$`, 'i') }).querySelector('button');
    expect(headerBtn).not.toBeNull();
    fireEvent.click(headerBtn!);
    const rows = screen.getAllByRole('row').filter((r) => r.querySelector('input[type="checkbox"]'));
    expect(rows[0]).toHaveTextContent(expectedFirstName);
  });

  it('clicking the active (WBS) column toggles to descending', () => {
    renderFlat();
    const wbsHeader = screen.getByRole('columnheader', { name: /^WBS$/i });
    const btn = wbsHeader.querySelector('button')!;
    fireEvent.click(btn);
    expect(wbsHeader).toHaveAttribute('aria-sort', 'descending');
    const rows = screen.getAllByRole('row').filter((r) => r.querySelector('input[type="checkbox"]'));
    expect(rows[0]).toHaveTextContent('Build');
  });

  it('renders the filtered-empty state when no tasks match', () => {
    render(
      <FlatMode
        filters={{ search: 'no-such-task', ownerFilter: '', statusFilter: '' }}
        onClearFilters={vi.fn()}
      />,
    );
    expect(screen.getByText(/no tasks match these filters/i)).toBeInTheDocument();
  });
});

describe('FlatMode — rename', () => {
  beforeEach(() => {
    updateMutate.mockReset();
  });

  it('double-click on a leaf row enters rename mode and Enter commits', () => {
    renderFlat();
    const rows = screen.getAllByRole('row').filter((r) => r.querySelector('input[type="checkbox"]'));
    fireEvent.doubleClick(rows[0]);
    const input = screen.getByLabelText('Rename task');
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateMutate).toHaveBeenCalledWith(expect.objectContaining({ name: 'New name' }));
  });

  it('renaming to an empty string is a no-op', () => {
    renderFlat();
    const rows = screen.getAllByRole('row').filter((r) => r.querySelector('input[type="checkbox"]'));
    fireEvent.doubleClick(rows[0]);
    const input = screen.getByLabelText('Rename task');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('Escape inside the rename input cancels without dispatching', () => {
    renderFlat();
    const rows = screen.getAllByRole('row').filter((r) => r.querySelector('input[type="checkbox"]'));
    fireEvent.doubleClick(rows[0]);
    const input = screen.getByLabelText('Rename task');
    fireEvent.change(input, { target: { value: 'Cancelled' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('Enter on a column header button activates sort via keyboard', () => {
    renderFlat();
    const nameHeader = screen.getByRole('columnheader', { name: /^Name$/i });
    const btn = nameHeader.querySelector('button')!;
    fireEvent.keyDown(btn, { key: 'Enter' });
    // After keyboard activation, Name column becomes the sorted column ascending.
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
  });

  it('Space on a column header button also activates sort', () => {
    renderFlat();
    const nameHeader = screen.getByRole('columnheader', { name: /^Name$/i });
    const btn = nameHeader.querySelector('button')!;
    fireEvent.keyDown(btn, { key: ' ' });
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
  });
});
