import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import type { TaskHistoryRecord } from '@/hooks/useTaskHistory';
import type { TaskComment } from '@/types';

// ---------------------------------------------------------------------------
// Mock the two feeds the timeline merges
// ---------------------------------------------------------------------------

interface MockHistoryResult {
  data: { pages: { results: TaskHistoryRecord[]; next: string | null }[] } | undefined;
  isLoading: boolean;
  error: unknown;
  fetchNextPage: ReturnType<typeof vi.fn>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

const historySpy = vi.hoisted(() => vi.fn<() => MockHistoryResult>());
const commentsSpy = vi.hoisted(() =>
  vi.fn<() => { comments: TaskComment[]; isLoading: boolean; error: unknown }>(),
);

vi.mock('@/hooks/useTaskHistory', () => ({
  useTaskHistory: () => historySpy(),
}));
vi.mock('@/hooks/useTaskComments', () => ({
  useTaskComments: () => commentsSpy(),
}));
vi.mock('@/lib/formatRelative', () => ({
  formatRelative: () => '2h ago',
}));

const { ActivityTimeline } = await import('./ActivityTimeline');

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

const multiRecord: TaskHistoryRecord = {
  id: 3,
  history_date: '2026-05-03T10:00:00Z',
  history_type: '~',
  history_user: 'carol',
  diff: [
    { field: 'name', old: 'Old name', new: 'New name' },
    { field: 'percent_complete', old: '0', new: '25' },
    { field: 'duration', old: '5', new: '7' },
  ],
};

// An empty `~` diff — the bare "Updated" pill the client must suppress (#874).
const emptyChange: TaskHistoryRecord = {
  id: 4,
  history_date: '2026-05-04T10:00:00Z',
  history_type: '~',
  history_user: 'dave',
  diff: [],
};

function makeComment(over: Partial<TaskComment> = {}): TaskComment {
  return {
    id: 'c1',
    task: 't1',
    parent: null,
    author: { id: 'u-erin', username: 'erin', display_name: 'Erin' },
    body: 'Looks good to me',
    edited_at: null,
    created_at: '2026-05-05T10:00:00Z',
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    acknowledged_count: 0,
    reaction_count: 0,
    has_my_acknowledgement: false,
    ...over,
  };
}

function makeHistory(records: TaskHistoryRecord[], hasNext = false): MockHistoryResult {
  return {
    data: { pages: [{ results: records, next: hasNext ? 'next-url' : null }] },
    isLoading: false,
    error: null,
    fetchNextPage: vi.fn(),
    hasNextPage: hasNext,
    isFetchingNextPage: false,
  };
}

function setComments(comments: TaskComment[] = [], error: unknown = null) {
  commentsSpy.mockReturnValue({ comments, isLoading: false, error });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActivityTimeline', () => {
  beforeEach(() => {
    historySpy.mockReset();
    commentsSpy.mockReset();
    historySpy.mockReturnValue(makeHistory([]));
    setComments([]);
  });

  it('renders the skeleton while history is loading', () => {
    historySpy.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByLabelText(/Loading activity/i)).toBeInTheDocument();
  });

  it('shows the empty state when there is no history and no comments', () => {
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/No activity yet/i)).toBeInTheDocument();
  });

  it('renders an "All" radio plus a chip only for groups present in the data', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord, multiRecord]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByRole('radio', { name: /^All/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Estimates' })).toBeInTheDocument(); // duration
    expect(screen.getByRole('radio', { name: 'Description' })).toBeInTheDocument(); // name
    // No assignment changes occurred → no Assignment chip (chips are data-driven).
    expect(screen.queryByRole('radio', { name: 'Assignment' })).not.toBeInTheDocument();
  });

  it('marks the All radio checked by default', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByRole('radio', { name: /^All/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('filters by field group (Status shows only status changes)', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord, multiRecord]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Status' }));
    expect(screen.getByText(/changed status/i)).toBeInTheDocument();
    expect(screen.queryByText(/updated 3 fields/i)).not.toBeInTheDocument();
  });

  it('merges comments into the timeline as a read-only "commented" event', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord]));
    setComments([makeComment()]);
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('commented')).toBeInTheDocument();
    expect(screen.getByText('Looks good to me')).toBeInTheDocument();
    // The comment author surfaces as the actor (the row span, not the person-filter option).
    expect(screen.getByText('Erin', { selector: 'span' })).toBeInTheDocument();
  });

  it('the Comments filter shows only comment events', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord]));
    setComments([makeComment()]);
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Comments' }));
    expect(screen.getByText('commented')).toBeInTheDocument();
    expect(screen.queryByText(/changed status/i)).not.toBeInTheDocument();
  });

  it('collapses a multi-field change behind an expand control that reveals diffs', () => {
    historySpy.mockReturnValue(makeHistory([multiRecord]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/updated 3 fields/i)).toBeInTheDocument();
    // Diffs hidden until expanded.
    expect(screen.queryByText('25%')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show changes/i }));
    expect(screen.getByText('25%')).toBeInTheDocument(); // percent_complete formatted
    expect(screen.getByText('New name')).toBeInTheDocument();
  });

  it('shows a single-field change inline with no expand control', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/changed status/i)).toBeInTheDocument();
    // Inline diff is visible immediately; no expand button.
    expect(screen.getByText(/In progress/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show changes/i })).not.toBeInTheDocument();
  });

  it('suppresses an empty-diff change record (the bare "Updated" pill)', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord, emptyChange]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.queryByText('dave')).not.toBeInTheDocument();
    // "All · 1" — only the status record counts, the empty record is dropped.
    expect(screen.getByRole('radio', { name: 'All · 1' })).toBeInTheDocument();
  });

  it('renders the task-creation event', () => {
    historySpy.mockReturnValue(makeHistory([createdRecord]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/created this task/i)).toBeInTheDocument();
  });

  it('filters by person (only that actor’s events remain)', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord, multiRecord]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    fireEvent.change(screen.getByLabelText(/Filter activity by person/i), {
      target: { value: 'bob' },
    });
    expect(screen.getByText(/changed status/i)).toBeInTheDocument();
    expect(screen.queryByText(/updated 3 fields/i)).not.toBeInTheDocument();
  });

  it('shows a relative timestamp on each event', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('2h ago')).toBeInTheDocument();
  });

  it('shows Load more whenever more pages exist and calls fetchNextPage', () => {
    const mock = makeHistory([statusRecord], true);
    historySpy.mockReturnValue(mock);
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByRole('button', { name: /Load more/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Load more/i }));
    expect(mock.fetchNextPage).toHaveBeenCalledOnce();
  });

  it('keeps Load more visible while a group filter is active (#1880)', () => {
    const mock = makeHistory([statusRecord, multiRecord], true);
    historySpy.mockReturnValue(mock);
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    // A filtered view still paginates over the full feed — hiding the button
    // silently truncated results to the already-loaded pages (#1880).
    fireEvent.click(screen.getByRole('radio', { name: 'Status' }));
    const loadMore = screen.getByRole('button', { name: /Load more/i });
    expect(loadMore).toBeInTheDocument();
    fireEvent.click(loadMore);
    expect(mock.fetchNextPage).toHaveBeenCalledOnce();
  });

  it('keeps Load more visible while a person filter is active (#1880)', () => {
    const mock = makeHistory([statusRecord, multiRecord], true);
    historySpy.mockReturnValue(mock);
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    fireEvent.change(screen.getByLabelText(/Filter activity by person/i), {
      target: { value: 'bob' },
    });
    expect(screen.getByRole('button', { name: /Load more/i })).toBeInTheDocument();
  });

  it('hides Load more when there are no further pages', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord], false));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument();
  });

  it('degrades to history-only when the comments feed errors (non-fatal)', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord]));
    setComments([], new Error('boom'));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/changed status/i)).toBeInTheDocument();
  });
});
