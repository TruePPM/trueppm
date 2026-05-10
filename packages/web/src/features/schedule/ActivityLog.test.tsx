import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import type { TaskHistoryRecord } from '@/hooks/useTaskHistory';

// ---------------------------------------------------------------------------
// Mock useTaskHistory
// ---------------------------------------------------------------------------

interface MockHistoryResult {
  data: { pages: { results: TaskHistoryRecord[]; next: string | null }[] } | undefined;
  isLoading: boolean;
  fetchNextPage: ReturnType<typeof vi.fn>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

const historySpy = vi.hoisted(() => vi.fn<() => MockHistoryResult>());

vi.mock('@/hooks/useTaskHistory', () => ({
  useTaskHistory: () => historySpy(),
}));

vi.mock('@/lib/formatRelative', () => ({
  formatRelative: () => '2h ago',
}));

// Import after mocks
const { ActivityLog } = await import('./ActivityLog');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const createdRecord: TaskHistoryRecord = {
  id: 1,
  history_date: '2026-05-01T10:00:00Z',
  history_type: '+',
  history_user: 'alice',
  diff: [],
};

const statusRecord: TaskHistoryRecord = {
  id: 2,
  history_date: '2026-05-02T10:00:00Z',
  history_type: '~',
  history_user: 'bob',
  diff: [{ field: 'status', old: 'NOT_STARTED', new: 'IN_PROGRESS' }],
};

const editRecord: TaskHistoryRecord = {
  id: 3,
  history_date: '2026-05-03T10:00:00Z',
  history_type: '~',
  history_user: 'carol',
  diff: [{ field: 'name', old: 'Old name', new: 'New name' }],
};

const systemRecord: TaskHistoryRecord = {
  id: 4,
  history_date: '2026-05-04T10:00:00Z',
  history_type: '~',
  history_user: null,
  diff: [{ field: 'duration', old: '5', new: '7' }],
};

function makeHistory(records: TaskHistoryRecord[], hasNext = false): MockHistoryResult {
  return {
    data: { pages: [{ results: records, next: hasNext ? 'next-url' : null }] },
    isLoading: false,
    fetchNextPage: vi.fn(),
    hasNextPage: hasNext,
    isFetchingNextPage: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActivityLog', () => {
  beforeEach(() => {
    historySpy.mockReset();
    historySpy.mockReturnValue(makeHistory([]));
  });

  it('renders skeleton while loading', () => {
    historySpy.mockReturnValue({
      data: undefined,
      isLoading: true,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    expect(screen.getByLabelText(/Loading activity/i)).toBeInTheDocument();
  });

  it('shows empty state when no records', () => {
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    expect(screen.getByText(/No activity yet/i)).toBeInTheDocument();
  });

  it('renders filter chips', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord, systemRecord]));
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    expect(screen.getByRole('button', { name: /All/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Status/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edits/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /System/i })).toBeInTheDocument();
  });

  it('All chip is pressed by default', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord]));
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    expect(screen.getByRole('button', { name: /All/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('filtering by Status shows only status events', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord, editRecord, systemRecord]));
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    fireEvent.click(screen.getByRole('button', { name: /Status/i }));
    // Status record verb
    expect(screen.getByText(/changed status/i)).toBeInTheDocument();
    // Edit record verb should not appear
    expect(screen.queryByText(/renamed task/i)).not.toBeInTheDocument();
  });

  it('filtering by System shows only system events', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord, systemRecord]));
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    fireEvent.click(screen.getByRole('button', { name: /System/i }));
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.queryByText('bob')).not.toBeInTheDocument();
  });

  it('empty state message changes when a filter chip yields no results', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord])); // no system events
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    fireEvent.click(screen.getByRole('button', { name: /System/i }));
    expect(screen.getByText(/No system events/i)).toBeInTheDocument();
  });

  it('renders username for user events', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord]));
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('renders System label for events with no history_user', () => {
    historySpy.mockReturnValue(makeHistory([systemRecord]));
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    // The italic "System" label in the event row (not the filter chip button)
    const systemLabel = screen.getByText('System', { selector: 'span' });
    expect(systemLabel).toBeInTheDocument();
  });

  it('renders status change detail', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord]));
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    expect(screen.getByText(/Not started → In progress/i)).toBeInTheDocument();
  });

  it('renders task creation verb', () => {
    historySpy.mockReturnValue(makeHistory([createdRecord]));
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    expect(screen.getByText(/created this task/i)).toBeInTheDocument();
  });

  it('shows timestamp on each record', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord]));
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    expect(screen.getByText('2h ago')).toBeInTheDocument();
  });

  it('shows Load more button when hasNextPage is true', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord], true));
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    expect(screen.getByRole('button', { name: /Load more/i })).toBeInTheDocument();
  });

  it('does not show Load more when filter is active', () => {
    const mock = makeHistory([statusRecord], true);
    historySpy.mockReturnValue(mock);
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    fireEvent.click(screen.getByRole('button', { name: /Status/i }));
    expect(screen.queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument();
  });

  it('calls fetchNextPage on Load more click', () => {
    const mock = makeHistory([statusRecord], true);
    historySpy.mockReturnValue(mock);
    renderWithProviders(<ActivityLog projectId="p1" taskId="t1" />);
    fireEvent.click(screen.getByRole('button', { name: /Load more/i }));
    expect(mock.fetchNextPage).toHaveBeenCalledOnce();
  });
});
