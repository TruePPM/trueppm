import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import type { TaskActivityEntry, TaskHistoryDiff } from '@/hooks/useTaskHistory';

// ---------------------------------------------------------------------------
// The timeline reads ONE merged feed now (#1883) — the client-side comment
// merge is gone, so there is nothing to mock but useTaskHistory.
// ---------------------------------------------------------------------------

interface MockHistoryResult {
  data: { pages: { results: TaskActivityEntry[]; next: string | null }[] } | undefined;
  isLoading: boolean;
  error: unknown;
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

const { ActivityTimeline } = await import('./ActivityTimeline');

// ---------------------------------------------------------------------------
// Fixture builders — every entry carries the unified {event_type, actor,
// timestamp, detail} shape; field-diff entries additionally carry diff.
// ---------------------------------------------------------------------------

function evt(over: Partial<TaskActivityEntry> = {}): TaskActivityEntry {
  return {
    event_type: 'fields_changed',
    actor: { id: 'u-bob', display_name: 'Bob' },
    timestamp: '2026-05-02T10:00:00Z',
    detail: {},
    ...over,
  };
}

function field(diff: TaskHistoryDiff[], over: Partial<TaskActivityEntry> = {}): TaskActivityEntry {
  return evt({
    id: 1,
    event_type: 'fields_changed',
    history_type: '~',
    history_date: over.timestamp ?? '2026-05-02T10:00:00Z',
    diff,
    detail: { diff },
    ...over,
  });
}

const createdRecord = field([], {
  id: 1,
  event_type: 'task_created',
  history_type: '+',
  actor: { id: 'u-alice', display_name: 'Alice' },
  timestamp: '2026-05-01T10:00:00Z',
});

const statusRecord = field([{ field: 'status', old: 'NOT_STARTED', new: 'IN_PROGRESS' }], {
  id: 2,
  actor: { id: 'u-bob', display_name: 'Bob' },
  timestamp: '2026-05-02T10:00:00Z',
});

const multiRecord = field(
  [
    { field: 'name', old: 'Old name', new: 'New name' },
    { field: 'percent_complete', old: '0', new: '25' },
    { field: 'duration', old: '5', new: '7' },
  ],
  { id: 3, actor: { id: 'u-carol', display_name: 'Carol' }, timestamp: '2026-05-03T10:00:00Z' },
);

// An empty `~` diff — the bare "Updated" pill the client must suppress (#874).
const emptyChange = field([], {
  id: 4,
  actor: { id: 'u-dave', display_name: 'Dave' },
  timestamp: '2026-05-04T10:00:00Z',
});

const commentEvent = evt({
  event_type: 'comment_added',
  actor: { id: 'u-erin', display_name: 'Erin' },
  timestamp: '2026-05-05T10:00:00Z',
  detail: { comment_id: 'c1', parent_id: null, preview: 'Looks good to me' },
});

function makeHistory(records: TaskActivityEntry[], hasNext = false): MockHistoryResult {
  return {
    data: { pages: [{ results: records, next: hasNext ? 'next-url' : null }] },
    isLoading: false,
    error: null,
    fetchNextPage: vi.fn(),
    hasNextPage: hasNext,
    isFetchingNextPage: false,
  };
}

// ---------------------------------------------------------------------------
// Core suite
// ---------------------------------------------------------------------------

describe('ActivityTimeline', () => {
  beforeEach(() => {
    historySpy.mockReset();
    historySpy.mockReturnValue(makeHistory([]));
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

  it('shows the empty state when there is no activity', () => {
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

  it('renders a comment_added event as a read-only "commented" event', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord, commentEvent]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('commented')).toBeInTheDocument();
    expect(screen.getByText('Looks good to me')).toBeInTheDocument();
    // The comment author surfaces as the actor (the row span, not the person-filter option).
    expect(screen.getByText('Erin', { selector: 'span' })).toBeInTheDocument();
  });

  it('the Comments filter shows only comment events', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord, commentEvent]));
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
    expect(screen.queryByText('Dave')).not.toBeInTheDocument();
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
      target: { value: 'u-bob' },
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
      target: { value: 'u-bob' },
    });
    expect(screen.getByRole('button', { name: /Load more/i })).toBeInTheDocument();
  });

  it('hides Load more when there are no further pages', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord], false));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// New event types surfaced by adopting ?include= (#1883)
// ---------------------------------------------------------------------------

describe('ActivityTimeline — schedule / risk / time / attachment events (#1883)', () => {
  beforeEach(() => {
    historySpy.mockReset();
    historySpy.mockReturnValue(makeHistory([]));
  });

  it('renders a cpm_recalculated system event under the Schedule chip', () => {
    const cpm = evt({
      event_type: 'cpm_recalculated',
      actor: null, // system event
      timestamp: '2026-05-06T10:00:00Z',
      detail: { early_finish: { from: '2026-06-01', to: '2026-06-03' }, is_critical: true },
    });
    historySpy.mockReturnValue(makeHistory([cpm]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByRole('radio', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.getByText(/recalculated the schedule/i)).toBeInTheDocument();
    // System actor renders as "System", and the critical-path delta surfaces.
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getByText(/on the critical path/i)).toBeInTheDocument();
  });

  it('renders baseline_drift_detected with a drift detail line under Schedule', () => {
    const drift = evt({
      event_type: 'baseline_drift_detected',
      actor: null,
      timestamp: '2026-05-06T11:00:00Z',
      detail: { baseline_id: 'b1', drift_days: 4 },
    });
    historySpy.mockReturnValue(makeHistory([drift]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByRole('radio', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.getByText(/detected baseline drift/i)).toBeInTheDocument();
    expect(screen.getByText(/4d behind baseline/i)).toBeInTheDocument();
  });

  it('renders risk_linked / risk_unlinked under the Risks chip with the risk title', () => {
    const linked = evt({
      event_type: 'risk_linked',
      actor: { id: 'u-bob', display_name: 'Bob' },
      timestamp: '2026-05-06T12:00:00Z',
      detail: { risk_id: 'r1', risk_short_id: 'R-7', risk_title: 'Vendor slip' },
    });
    historySpy.mockReturnValue(makeHistory([linked]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByRole('radio', { name: 'Risks' })).toBeInTheDocument();
    expect(screen.getByText(/linked a risk/i)).toBeInTheDocument();
    expect(screen.getByText(/R-7 · Vendor slip/)).toBeInTheDocument();
  });

  it('renders time_logged under the Time chip with a formatted duration', () => {
    const logged = evt({
      event_type: 'time_logged',
      actor: { id: 'u-erin', display_name: 'Erin' },
      timestamp: '2026-05-06T13:00:00Z',
      detail: { time_entry_id: 'te1', minutes: 90, entry_date: '2026-05-06' },
    });
    historySpy.mockReturnValue(makeHistory([logged]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByRole('radio', { name: 'Time' })).toBeInTheDocument();
    expect(screen.getByText(/logged time/i)).toBeInTheDocument();
    expect(screen.getByText(/1h 30m/)).toBeInTheDocument();
  });

  it('renders time_deleted under the Time chip (source event from #1888)', () => {
    const removed = evt({
      event_type: 'time_deleted',
      actor: { id: 'u-erin', display_name: 'Erin' },
      timestamp: '2026-05-06T14:00:00Z',
      detail: { time_entry_id: 'te1', minutes: 45, entry_date: '2026-05-06' },
    });
    historySpy.mockReturnValue(makeHistory([removed]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByRole('radio', { name: 'Time' })).toBeInTheDocument();
    expect(screen.getByText(/deleted a time entry/i)).toBeInTheDocument();
    expect(screen.getByText(/45m/)).toBeInTheDocument();
  });

  it('renders attachment_uploaded / attachment_deleted under the Attachments chip', () => {
    const uploaded = evt({
      event_type: 'attachment_uploaded',
      actor: { id: 'u-bob', display_name: 'Bob' },
      timestamp: '2026-05-06T15:00:00Z',
      detail: { attachment_id: 'a1', kind: 'file', label: 'spec.pdf' },
    });
    const deleted = evt({
      event_type: 'attachment_deleted',
      actor: { id: 'u-bob', display_name: 'Bob' },
      timestamp: '2026-05-06T16:00:00Z',
      detail: { attachment_id: 'a1', kind: 'file', label: 'spec.pdf' },
    });
    historySpy.mockReturnValue(makeHistory([uploaded, deleted]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByRole('radio', { name: 'Attachments' })).toBeInTheDocument();
    expect(screen.getByText(/attached a file/i)).toBeInTheDocument();
    expect(screen.getByText(/deleted an attachment/i)).toBeInTheDocument();
    expect(screen.getAllByText('spec.pdf')).toHaveLength(2);
  });

  it('labels a URL attachment as a link', () => {
    const link = evt({
      event_type: 'attachment_uploaded',
      actor: { id: 'u-bob', display_name: 'Bob' },
      timestamp: '2026-05-06T15:30:00Z',
      detail: { attachment_id: 'a2', kind: 'url', label: 'Design doc' },
    });
    historySpy.mockReturnValue(makeHistory([link]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/attached a link/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Comment lifecycle — the core #1883 bug: edited/deleted comments must surface
// ---------------------------------------------------------------------------

describe('ActivityTimeline — comment lifecycle (#1883)', () => {
  beforeEach(() => {
    historySpy.mockReset();
    historySpy.mockReturnValue(makeHistory([]));
  });

  it('surfaces an edited comment (no longer silently missing)', () => {
    const edited = evt({
      event_type: 'comment_edited',
      actor: { id: 'u-erin', display_name: 'Erin' },
      timestamp: '2026-05-07T10:00:00Z',
      detail: { comment_id: 'c1', preview: 'Reworded take' },
    });
    historySpy.mockReturnValue(makeHistory([edited]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/edited a comment/i)).toBeInTheDocument();
    expect(screen.getByText('Reworded take')).toBeInTheDocument();
  });

  it('renders a deleted comment instead of dropping it (the core bug)', () => {
    const deleted = evt({
      event_type: 'comment_deleted',
      actor: { id: 'u-erin', display_name: 'Erin' },
      timestamp: '2026-05-07T11:00:00Z',
      detail: { comment_id: 'c1' },
    });
    historySpy.mockReturnValue(makeHistory([deleted]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/deleted a comment/i)).toBeInTheDocument();
    // No body is resurfaced for a deleted comment.
    expect(screen.getByRole('radio', { name: 'Comments' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Actor identity (#1878) — now deduped on the unified actor.id
// ---------------------------------------------------------------------------

describe('ActivityTimeline — actor identity (#1878)', () => {
  const yukiChange = field([{ field: 'status', old: 'NOT_STARTED', new: 'IN_PROGRESS' }], {
    id: 20,
    actor: { id: 'u-yuki', display_name: 'Yuki Tanaka' },
    timestamp: '2026-05-06T10:00:00Z',
  });
  const bobChange = field([{ field: 'duration', old: '5', new: '7' }], {
    id: 21,
    actor: { id: 'u-bob', display_name: 'Bob' },
    timestamp: '2026-05-07T10:00:00Z',
  });
  const yukiComment = evt({
    event_type: 'comment_added',
    actor: { id: 'u-yuki', display_name: 'Yuki Tanaka' },
    timestamp: '2026-05-08T10:00:00Z',
    detail: { comment_id: 'c-yuki', parent_id: null, preview: 'On it.' },
  });

  beforeEach(() => {
    historySpy.mockReset();
    historySpy.mockReturnValue(makeHistory([]));
  });

  it('dedupes the same human across event sources in the person filter', () => {
    historySpy.mockReturnValue(makeHistory([yukiChange, bobChange, yukiComment]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    // Exactly ONE option for Yuki (a change event + a comment event → one person).
    expect(screen.getAllByRole('option', { name: 'Yuki Tanaka' })).toHaveLength(1);
  });

  it('filtering by the deduped person shows both their change and comment events', () => {
    historySpy.mockReturnValue(makeHistory([yukiChange, bobChange, yukiComment]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    fireEvent.change(screen.getByLabelText(/Filter activity by person/i), {
      target: { value: 'u-yuki' },
    });
    expect(screen.getByText(/changed status/i)).toBeInTheDocument();
    expect(screen.getByText('commented')).toBeInTheDocument();
    // Bob's event is filtered out.
    expect(screen.queryByText(/changed duration/i)).not.toBeInTheDocument();
  });

  it('renders the display name on event rows', () => {
    historySpy.mockReturnValue(makeHistory([yukiChange]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('Yuki Tanaka', { selector: 'span' })).toBeInTheDocument();
  });

  it('renders "System" for a null actor and excludes it from the person filter', () => {
    const cpm = evt({
      event_type: 'cpm_recalculated',
      actor: null,
      timestamp: '2026-05-09T10:00:00Z',
      detail: {},
    });
    historySpy.mockReturnValue(makeHistory([cpm, bobChange]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('System')).toBeInTheDocument();
    // System is not a person option.
    expect(screen.queryByRole('option', { name: 'System' })).not.toBeInTheDocument();
  });

  it('gives priority_rank changes the Estimates filter chip (#1885)', () => {
    const rankChange = field([{ field: 'priority_rank', old: '3', new: '1' }], {
      id: 22,
      actor: { id: 'u-bob', display_name: 'Bob' },
      timestamp: '2026-05-09T10:00:00Z',
    });
    historySpy.mockReturnValue(makeHistory([rankChange]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByRole('radio', { name: 'Estimates' })).toBeInTheDocument();
    expect(screen.getByText(/changed priority/i)).toBeInTheDocument();
  });
});
