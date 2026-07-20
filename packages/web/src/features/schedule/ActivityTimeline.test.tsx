import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders, renderWithProvidersAndRouter } from '@/test/utils';
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

  it('renders a legacy cpm_recalculated row with the old Finish / critical-path line', () => {
    // A pre-#1948 row carries no recalc_moved_count → the original fallback copy.
    const cpm = evt({
      event_type: 'cpm_recalculated',
      actor: null, // system event
      timestamp: '2026-05-06T10:00:00Z',
      detail: { early_finish: { from: '2026-06-01', to: '2026-06-03' }, is_critical: true },
    });
    historySpy.mockReturnValue(makeHistory([cpm]));
    renderWithProvidersAndRouter(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByRole('radio', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.getByText(/recalculated the schedule/i)).toBeInTheDocument();
    // System actor renders as "System", and the critical-path delta surfaces.
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getByText(/on the critical path/i)).toBeInTheDocument();
  });

  it('renders the #1948 recalc summary: N tasks moved · finish slip, with a schedule link', () => {
    const cpm = evt({
      event_type: 'cpm_recalculated',
      actor: null,
      timestamp: '2026-05-06T10:00:00Z',
      detail: {
        early_finish: { from: '2026-06-01', to: '2026-06-07' },
        recalc_moved_count: 12,
        recalc_finish: '2026-06-07',
        recalc_finish_delta_days: 6,
      },
    });
    historySpy.mockReturnValue(makeHistory([cpm]));
    renderWithProvidersAndRouter(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/recalculated the schedule/i)).toBeInTheDocument();
    expect(screen.getByText('12 tasks moved · finish +6d')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /View in schedule/i });
    expect(link).toHaveAttribute('href', '/projects/p1/schedule');
  });

  it('renders a pull-in as a negative finish delta', () => {
    const cpm = evt({
      event_type: 'cpm_recalculated',
      actor: null,
      timestamp: '2026-05-06T10:00:00Z',
      detail: { recalc_moved_count: 4, recalc_finish: '2026-06-01', recalc_finish_delta_days: -2 },
    });
    historySpy.mockReturnValue(makeHistory([cpm]));
    renderWithProvidersAndRouter(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('4 tasks moved · finish -2d')).toBeInTheDocument();
  });

  it('renders "finish unchanged" when the delta is zero', () => {
    const cpm = evt({
      event_type: 'cpm_recalculated',
      actor: null,
      timestamp: '2026-05-06T10:00:00Z',
      detail: { recalc_moved_count: 3, recalc_finish: '2026-06-01', recalc_finish_delta_days: 0 },
    });
    historySpy.mockReturnValue(makeHistory([cpm]));
    renderWithProvidersAndRouter(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('3 tasks moved · finish unchanged')).toBeInTheDocument();
  });

  it('omits the finish clause when the delta is null (first recalc)', () => {
    const cpm = evt({
      event_type: 'cpm_recalculated',
      actor: null,
      timestamp: '2026-05-06T10:00:00Z',
      detail: {
        recalc_moved_count: 12,
        recalc_finish: '2026-06-07',
        recalc_finish_delta_days: null,
      },
    });
    historySpy.mockReturnValue(makeHistory([cpm]));
    renderWithProvidersAndRouter(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('12 tasks moved')).toBeInTheDocument();
  });

  it('uses the singular noun for a single moved task', () => {
    const cpm = evt({
      event_type: 'cpm_recalculated',
      actor: null,
      timestamp: '2026-05-06T10:00:00Z',
      detail: { recalc_moved_count: 1, recalc_finish: '2026-06-01', recalc_finish_delta_days: 1 },
    });
    historySpy.mockReturnValue(makeHistory([cpm]));
    renderWithProvidersAndRouter(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('1 task moved · finish +1d')).toBeInTheDocument();
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
    renderWithProvidersAndRouter(<ActivityTimeline projectId="p1" taskId="t1" />);
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

// ---------------------------------------------------------------------------
// Legacy field-diff payloads — normalize() infers event_type / timestamp / actor
// from the pre-#1883 shape (older cache or a mock returning the legacy payload).
// ---------------------------------------------------------------------------

/** A pre-#1883 legacy entry: no `event_type`/`timestamp`, only history_* keys. */
function legacy(over: Record<string, unknown>): TaskActivityEntry {
  return { detail: {}, ...over } as unknown as TaskActivityEntry;
}

describe('ActivityTimeline — legacy payload normalization', () => {
  beforeEach(() => {
    historySpy.mockReset();
    historySpy.mockReturnValue(makeHistory([]));
  });

  it('infers task_created from a legacy history_type "+" entry', () => {
    const rec = legacy({
      id: 30,
      history_type: '+',
      history_date: '2026-05-01T10:00:00Z',
      history_user: 'u-alice',
      history_user_display: 'Alice A',
      diff: [],
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/created this task/i)).toBeInTheDocument();
    // Actor inferred from history_user_display.
    expect(screen.getByText('Alice A', { selector: 'span' })).toBeInTheDocument();
  });

  it('infers task_deleted from a legacy history_type "-" entry', () => {
    const rec = legacy({
      id: 31,
      history_type: '-',
      history_date: '2026-05-02T10:00:00Z',
      history_user: 'u-bob',
      history_user_display: 'Bob B',
      diff: [],
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/deleted this task/i)).toBeInTheDocument();
  });

  it('infers fields_changed from a legacy "~" entry and renders its diff', () => {
    const rec = legacy({
      id: 32,
      history_type: '~',
      history_date: '2026-05-03T10:00:00Z',
      history_user: 'u-carol',
      history_user_display: 'Carol C',
      diff: [{ field: 'status', old: 'NOT_STARTED', new: 'IN_PROGRESS' }],
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/changed status/i)).toBeInTheDocument();
    expect(screen.getByText(/In progress/i)).toBeInTheDocument();
  });

  it('falls back to the raw history_user id when no display name is present', () => {
    const rec = legacy({
      id: 33,
      history_type: '~',
      history_date: '2026-05-03T10:00:00Z',
      history_user: 'u-noname',
      history_user_display: null,
      diff: [{ field: 'status', old: 'NOT_STARTED', new: 'IN_PROGRESS' }],
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('u-noname', { selector: 'span' })).toBeInTheDocument();
  });

  it('renders a legacy authorless entry (no history_user) as System', () => {
    const rec = legacy({
      id: 34,
      history_type: '~',
      history_date: '2026-05-03T10:00:00Z',
      history_user: null,
      diff: [{ field: 'status', old: 'NOT_STARTED', new: 'IN_PROGRESS' }],
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('System')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// GroupFilter keyboard navigation (roving tabindex, web-rule 167)
// ---------------------------------------------------------------------------

describe('ActivityTimeline — group filter keyboard navigation', () => {
  beforeEach(() => {
    historySpy.mockReset();
    // statusRecord → Status; multiRecord → Estimates/Description/Progress;
    // commentEvent → Comments. Chips: All, Status, Progress, Estimates,
    // Description, Comments.
    historySpy.mockReturnValue(makeHistory([statusRecord, multiRecord, commentEvent]));
  });

  it('ArrowRight moves roving focus to the next chip without committing selection', () => {
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    const group = screen.getByRole('radiogroup', { name: /Filter activity by type/i });
    const radios = screen.getAllByRole('radio');
    // Focus starts on the selected "All" chip (index 0).
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(radios[1]);
    // Roving focus alone does NOT change the checked chip.
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[1]).toHaveAttribute('aria-checked', 'false');
  });

  it('ArrowLeft moves focus back and clamps at the first chip', () => {
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    const group = screen.getByRole('radiogroup', { name: /Filter activity by type/i });
    const radios = screen.getAllByRole('radio');
    fireEvent.keyDown(group, { key: 'ArrowRight' }); // → index 1
    fireEvent.keyDown(group, { key: 'ArrowLeft' }); // → index 0
    expect(document.activeElement).toBe(radios[0]);
    // Already at the first chip — ArrowLeft clamps, stays put.
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(radios[0]);
  });

  it('End focuses the last chip and Home returns to the first', () => {
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    const group = screen.getByRole('radiogroup', { name: /Filter activity by type/i });
    const radios = screen.getAllByRole('radio');
    fireEvent.keyDown(group, { key: 'End' });
    expect(document.activeElement).toBe(radios[radios.length - 1]);
    // End again clamps at the last chip.
    fireEvent.keyDown(group, { key: 'End' });
    expect(document.activeElement).toBe(radios[radios.length - 1]);
    fireEvent.keyDown(group, { key: 'Home' });
    expect(document.activeElement).toBe(radios[0]);
  });

  it('ArrowDown / ArrowUp behave as forward / backward aliases', () => {
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    const group = screen.getByRole('radiogroup', { name: /Filter activity by type/i });
    const radios = screen.getAllByRole('radio');
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(radios[1]);
    fireEvent.keyDown(group, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(radios[0]);
  });

  it('ignores unrelated keys (no focus movement)', () => {
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    const group = screen.getByRole('radiogroup', { name: /Filter activity by type/i });
    const radios = screen.getAllByRole('radio');
    fireEvent.keyDown(group, { key: 'ArrowRight' }); // index 1
    fireEvent.keyDown(group, { key: 'a' }); // ignored
    expect(document.activeElement).toBe(radios[1]);
  });
});

// ---------------------------------------------------------------------------
// Error state, empty-filter result, pagination-in-flight, person reset
// ---------------------------------------------------------------------------

describe('ActivityTimeline — states and filter edges', () => {
  beforeEach(() => {
    historySpy.mockReset();
    historySpy.mockReturnValue(makeHistory([]));
  });

  it('renders an alert when the history request errors', () => {
    historySpy.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Couldn.t load activity/i);
  });

  it('shows "No matching activity" when the active filters exclude every event', () => {
    // Bob changed status; Erin commented. Filtering to Comments + Bob = nothing.
    historySpy.mockReturnValue(makeHistory([statusRecord, commentEvent]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Comments' }));
    fireEvent.change(screen.getByLabelText(/Filter activity by person/i), {
      target: { value: 'u-bob' },
    });
    expect(screen.getByText(/No matching activity/i)).toBeInTheDocument();
    expect(screen.queryByText('commented')).not.toBeInTheDocument();
  });

  it('disables Load more and shows a spinner label while fetching the next page', () => {
    historySpy.mockReturnValue({
      data: { pages: [{ results: [statusRecord], next: 'next-url' }] },
      isLoading: false,
      error: null,
      fetchNextPage: vi.fn(),
      hasNextPage: true,
      isFetchingNextPage: true,
    });
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    const btn = screen.getByRole('button', { name: /Loading/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/Loading/);
  });

  it('resetting the person filter to "Anyone" restores every event', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord, multiRecord]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    const select = screen.getByLabelText(/Filter activity by person/i);
    fireEvent.change(select, { target: { value: 'u-bob' } });
    expect(screen.queryByText(/updated 3 fields/i)).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: '' } });
    expect(screen.getByText(/changed status/i)).toBeInTheDocument();
    expect(screen.getByText(/updated 3 fields/i)).toBeInTheDocument();
  });

  it('falls back to All when the selected group chip disappears after a refetch', () => {
    historySpy.mockReturnValue(makeHistory([statusRecord, commentEvent]));
    const { rerender } = renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Comments' }));
    expect(screen.queryByText(/changed status/i)).not.toBeInTheDocument();
    // Refetch drops all comment events → the Comments chip no longer exists,
    // so the effective group falls back to All and the status event reappears.
    historySpy.mockReturnValue(makeHistory([statusRecord]));
    rerender(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.queryByRole('radio', { name: 'Comments' })).not.toBeInTheDocument();
    expect(screen.getByText(/changed status/i)).toBeInTheDocument();
  });

  it('falls back to Anyone when the selected person disappears after a refetch', () => {
    const erinComment = evt({
      event_type: 'comment_added',
      actor: { id: 'u-erin', display_name: 'Erin' },
      timestamp: '2026-05-05T10:00:00Z',
      detail: { comment_id: 'c9', preview: 'hi' },
    });
    historySpy.mockReturnValue(makeHistory([statusRecord, erinComment]));
    const { rerender } = renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    fireEvent.change(screen.getByLabelText(/Filter activity by person/i), {
      target: { value: 'u-erin' },
    });
    expect(screen.queryByText(/changed status/i)).not.toBeInTheDocument();
    // Refetch removes Erin's events → person filter falls back, status reappears.
    historySpy.mockReturnValue(makeHistory([statusRecord]));
    rerender(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/changed status/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Value formatting + detail-line edge branches
// ---------------------------------------------------------------------------

describe('ActivityTimeline — value formatting and detail edges', () => {
  beforeEach(() => {
    historySpy.mockReset();
    historySpy.mockReturnValue(makeHistory([]));
  });

  it('formats a date-field diff through the UTC short formatter', () => {
    const rec = field([{ field: 'planned_start', old: '2026-06-01', new: '2026-06-08' }], {
      id: 40,
      actor: { id: 'u-bob', display_name: 'Bob' },
      timestamp: '2026-05-02T10:00:00Z',
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('Start date')).toBeInTheDocument();
    // Rendered formatted (not the raw ISO string).
    expect(screen.queryByText('2026-06-08')).not.toBeInTheDocument();
    expect(screen.getByText('Jun 8')).toBeInTheDocument();
  });

  it('renders a raw percent value unchanged when it is not a finite number', () => {
    const rec = field([{ field: 'percent_complete', old: '0', new: 'n/a' }], {
      id: 41,
      actor: { id: 'u-bob', display_name: 'Bob' },
      timestamp: '2026-05-02T10:00:00Z',
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('n/a')).toBeInTheDocument();
  });

  it('renders a null diff value as an em dash', () => {
    const rec = field([{ field: 'notes', old: 'old note', new: null }], {
      id: 42,
      actor: { id: 'u-bob', display_name: 'Bob' },
      timestamp: '2026-05-02T10:00:00Z',
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('falls back to the raw status token for an unknown status value', () => {
    const rec = field([{ field: 'status', old: 'NOT_STARTED', new: 'ARCHIVED' }], {
      id: 43,
      actor: { id: 'u-bob', display_name: 'Bob' },
      timestamp: '2026-05-02T10:00:00Z',
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('ARCHIVED')).toBeInTheDocument();
  });

  it('renders the raw field name for a field without a friendly label', () => {
    const rec = field([{ field: 'custom_flag', old: 'a', new: 'b' }], {
      id: 44,
      actor: { id: 'u-bob', display_name: 'Bob' },
      timestamp: '2026-05-02T10:00:00Z',
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('custom_flag')).toBeInTheDocument();
  });

  it('renders "unlinked a risk" for a risk_unlinked event', () => {
    const rec = evt({
      event_type: 'risk_unlinked',
      actor: { id: 'u-bob', display_name: 'Bob' },
      timestamp: '2026-05-06T12:00:00Z',
      detail: { risk_id: 'r2', risk_short_id: 'R-9', risk_title: 'Scope creep' },
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/unlinked a risk/i)).toBeInTheDocument();
    expect(screen.getByText(/R-9 · Scope creep/)).toBeInTheDocument();
  });

  it('omits the risk detail line when neither short id nor title is present', () => {
    const rec = evt({
      event_type: 'risk_linked',
      actor: { id: 'u-bob', display_name: 'Bob' },
      timestamp: '2026-05-06T12:00:00Z',
      detail: { risk_id: 'r3' },
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/linked a risk/i)).toBeInTheDocument();
    // detailLine returns null → no risk short-id / title secondary line.
    expect(screen.queryByText(/R-\d/)).not.toBeInTheDocument();
  });

  it('renders time as an hours-only duration and without a date when none is given', () => {
    const rec = evt({
      event_type: 'time_logged',
      actor: { id: 'u-erin', display_name: 'Erin' },
      timestamp: '2026-05-06T13:00:00Z',
      detail: { time_entry_id: 'te2', minutes: 120 },
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText('2h')).toBeInTheDocument();
  });

  it('omits the time detail line when minutes are missing', () => {
    const rec = evt({
      event_type: 'time_logged',
      actor: { id: 'u-erin', display_name: 'Erin' },
      timestamp: '2026-05-06T13:00:00Z',
      detail: { time_entry_id: 'te3' },
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/logged time/i)).toBeInTheDocument();
    // Only the summary verb — no formatted duration secondary line.
    // (The "2h ago" node is the mocked relative timestamp, not a duration.)
    expect(screen.queryByText('2h')).not.toBeInTheDocument();
    expect(screen.queryByText(/on May/)).not.toBeInTheDocument();
  });

  it('omits the drift line when drift_days is missing', () => {
    const rec = evt({
      event_type: 'baseline_drift_detected',
      actor: null,
      timestamp: '2026-05-06T11:00:00Z',
      detail: { baseline_id: 'b1' },
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/detected baseline drift/i)).toBeInTheDocument();
    expect(screen.queryByText(/behind baseline/i)).not.toBeInTheDocument();
  });

  it('renders a legacy cpm row with no finish and no critical flag with no detail line', () => {
    const rec = evt({
      event_type: 'cpm_recalculated',
      actor: null,
      timestamp: '2026-05-06T10:00:00Z',
      detail: {},
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProvidersAndRouter(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/recalculated the schedule/i)).toBeInTheDocument();
    // No moved-count, no finish, not critical → no secondary line at all.
    expect(screen.queryByText(/critical path/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Finish/)).not.toBeInTheDocument();
  });

  it('renders a legacy cpm row with only a finish date (no critical flag)', () => {
    const rec = evt({
      event_type: 'cpm_recalculated',
      actor: null,
      timestamp: '2026-05-06T10:00:00Z',
      detail: { early_finish: { from: '2026-06-01', to: '2026-06-05' } },
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProvidersAndRouter(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/Finish/)).toBeInTheDocument();
    expect(screen.queryByText(/critical path/i)).not.toBeInTheDocument();
  });

  it('renders an unknown event_type by humanizing its verb and matching no chip', () => {
    const rec = evt({
      event_type: 'something_odd',
      actor: { id: 'u-bob', display_name: 'Bob' },
      timestamp: '2026-05-06T10:00:00Z',
      detail: {},
    });
    historySpy.mockReturnValue(makeHistory([rec]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    expect(screen.getByText(/something odd/)).toBeInTheDocument();
    // Matches no group → only the All chip is present.
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(screen.getByRole('radio', { name: /^All/ })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Multi-field expand/collapse toggle
// ---------------------------------------------------------------------------

describe('ActivityTimeline — expand/collapse toggle', () => {
  beforeEach(() => {
    historySpy.mockReset();
    historySpy.mockReturnValue(makeHistory([]));
  });

  it('toggles the diff open and closed and flips aria-expanded', () => {
    historySpy.mockReturnValue(makeHistory([multiRecord]));
    renderWithProviders(<ActivityTimeline projectId="p1" taskId="t1" />);
    const toggle = screen.getByRole('button', { name: /Show changes/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByText('New name')).toBeInTheDocument();
    // Now labelled to hide, and collapsing removes the diff again.
    const hide = screen.getByRole('button', { name: /Hide changes/i });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(hide);
    expect(screen.queryByText('New name')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show changes/i })).toBeInTheDocument();
  });
});
