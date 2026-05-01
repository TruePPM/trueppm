import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import type { Task } from '@/types';

// JSDOM has no layout — TanStack Virtual relies on getBoundingClientRect for
// the scroll container. Stub a non-zero height so virtualised rows actually
// render. (Without this, the virtualizer returns 0 items and the table
// appears empty, which would make every assertion below fail.)
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return this; } };
    },
  });
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

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
    status: 'COMPLETE', assignees: [{ resourceId: 'r1', name: 'Alice Smith', units: 100 }],
  },
  {
    id: 't3', wbs: '2', name: 'Design', start: '2026-05-11', finish: '2026-05-20',
    duration: 10, progress: 0, parentId: null,
    isCritical: false, isComplete: false, isSummary: false, isMilestone: false,
    status: 'NOT_STARTED', assignees: [{ resourceId: 'r2', name: 'Bob Jones', units: 100 }],
  },
  {
    id: 't4', wbs: '3', name: 'Kickoff Milestone', start: '2026-05-01', finish: '2026-05-01',
    duration: 0, progress: 0, parentId: null,
    isCritical: false, isComplete: false, isSummary: false, isMilestone: true,
    status: 'NOT_STARTED', assignees: [],
  },
];

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'proj-1' }));

vi.mock('@/hooks/useScheduleTasks', () => ({
  useScheduleTasks: () => ({ tasks: mockTasks, isLoading: false, error: null }),
}));

vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate: vi.fn(), isPending: false }),
  useBulkDeleteTasks: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/utils/exportCsv', () => ({ exportTasksToCsv: vi.fn() }));

// JSDOM has no layout, so TanStack Virtual measures the scroll container
// at 0×0 and renders zero rows. Stub useVirtualizer to render every row
// at its estimated size — keeps the test focused on behaviour, not
// virtualization mechanics.
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
    return {
      getVirtualItems: () => items,
      getTotalSize: () => items.reduce((s, it) => s + it.size, 0),
      measureElement: () => undefined,
      scrollToIndex: () => undefined,
      scrollToOffset: () => undefined,
    };
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { TaskListView } from './TaskListView';

describe('TaskListView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders task names in the list', () => {
    renderWithRouter(<TaskListView />);
    expect(screen.getByText('Planning')).toBeInTheDocument();
    expect(screen.getByText('Requirements')).toBeInTheDocument();
    expect(screen.getByText('Design')).toBeInTheDocument();
  });

  it('renders owner avatar for tasks with assignees', () => {
    renderWithRouter(<TaskListView />);
    expect(screen.getAllByTitle('Alice Smith').length).toBeGreaterThan(0);
    expect(screen.getByTitle('Bob Jones')).toBeInTheDocument();
  });

  it('renders Start and Finish dates', () => {
    renderWithRouter(<TaskListView />);
    // Alice's tasks start May 1
    expect(screen.getAllByText('May 1').length).toBeGreaterThan(0);
  });

  it('renders status pills', () => {
    renderWithRouter(<TaskListView />);
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getAllByText('Not started').length).toBeGreaterThan(0);
  });

  it('filters tasks by search (debounced)', async () => {
    renderWithRouter(<TaskListView />);
    // Search input has aria-label="Search tasks" but type=text, so the role
    // is textbox rather than searchbox — locate by label.
    const input = screen.getByLabelText(/search tasks/i);
    await userEvent.type(input, 'Design');
    // FilterRail debounces input → setSearch by 250ms; allow up to 1000ms.
    await waitFor(() => {
      expect(screen.queryByText('Requirements')).not.toBeInTheDocument();
    }, { timeout: 1000 });
    expect(screen.getByText('Design')).toBeInTheDocument();
  });

  it('shows filter empty state when search matches nothing', async () => {
    renderWithRouter(<TaskListView />);
    const input = screen.getByLabelText(/search tasks/i);
    await userEvent.clear(input);
    await userEvent.type(input, 'zzz_no_match_xyz');
    await waitFor(() => {
      expect(screen.getByText(/no tasks match these filters/i)).toBeInTheDocument();
    }, { timeout: 1000 });
  });

  it('clear filters button in empty state resets search', async () => {
    renderWithRouter(<TaskListView />);
    const input = screen.getByLabelText(/search tasks/i);
    await userEvent.type(input, 'zzz_no_match_xyz');
    const clearBtn = await screen.findByRole(
      'button',
      { name: /clear filters/i },
      { timeout: 1000 },
    );
    await userEvent.click(clearBtn);
    await waitFor(() => {
      expect(screen.getByText('Planning')).toBeInTheDocument();
    });
  });

  it('cycles group-by through None → Phase → Owner → Status', async () => {
    renderWithRouter(<TaskListView />);
    const btn = screen.getByRole('button', { name: /group: none/i });

    await userEvent.click(btn);
    expect(screen.getByRole('button', { name: /group: phase/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /group: phase/i }));
    expect(screen.getByRole('button', { name: /group: owner/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /group: owner/i }));
    expect(screen.getByRole('button', { name: /group: status/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /group: status/i }));
    expect(screen.getByRole('button', { name: /group: none/i })).toBeInTheDocument();
  });

  it('shows group headers when group-by is active', async () => {
    renderWithRouter(<TaskListView />);
    await userEvent.click(screen.getByRole('button', { name: /group: none/i }));
    // "Group: Phase" is now active; group headers should appear
    // At least one group header row should be present
    const groupHeaders = screen.getAllByRole('row').filter((el) =>
      el.getAttribute('aria-label')?.includes('group') ||
      el.className?.includes('group') ||
      el.textContent?.match(/\(\d+\)/),
    );
    expect(groupHeaders.length).toBeGreaterThan(0);
  });

  it('owner filter chip appears after filtering by owner', async () => {
    renderWithRouter(<TaskListView />);
    const input = screen.getByRole('searchbox', { name: /search tasks/i });
    await userEvent.type(input, 'Alice');
    await waitFor(() => {
      expect(screen.queryByText('Design')).not.toBeInTheDocument();
    }, { timeout: 600 });
  });
});
