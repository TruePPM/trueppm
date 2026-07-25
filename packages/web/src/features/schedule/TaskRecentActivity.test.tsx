import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import type { TaskActivityEntry } from '@/hooks/useTaskHistory';

interface MockHistoryResult {
  data: { pages: { results: TaskActivityEntry[]; next: string | null }[] } | undefined;
  isLoading: boolean;
  isError: boolean;
}

const historySpy = vi.hoisted(() => vi.fn<() => MockHistoryResult>());

vi.mock('@/hooks/useTaskHistory', () => ({
  useTaskHistory: () => historySpy(),
}));
vi.mock('@/lib/formatRelative', () => ({
  formatRelative: () => '2h ago',
}));

const { TaskRecentActivity } = await import('./TaskRecentActivity');

function evt(over: Partial<TaskActivityEntry> = {}): TaskActivityEntry {
  return {
    event_type: 'comment_added',
    actor: { id: 'u-bob', display_name: 'Bob' },
    timestamp: '2026-05-02T10:00:00Z',
    detail: {},
    ...over,
  };
}

function mockFeed(results: TaskActivityEntry[], over: Partial<MockHistoryResult> = {}) {
  historySpy.mockReturnValue({
    data: { pages: [{ results, next: null }] },
    isLoading: false,
    isError: false,
    ...over,
  });
}

function render(onViewAll = vi.fn()) {
  renderWithProviders(<TaskRecentActivity projectId="p1" taskId="t1" onViewAll={onViewAll} />);
  return onViewAll;
}

describe('TaskRecentActivity', () => {
  beforeEach(() => {
    historySpy.mockReset();
  });

  it('renders the actor, the summary verb, and a relative time per entry', () => {
    mockFeed([evt()]);
    render();
    expect(screen.getByRole('heading', { name: 'Recent activity' })).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('commented')).toBeInTheDocument();
    expect(screen.getByText('2h ago')).toBeInTheDocument();
  });

  it('caps the inline trail at three entries, newest first', () => {
    mockFeed([
      evt({ timestamp: '2026-05-01T10:00:00Z', actor: { id: 'a', display_name: 'Oldest' } }),
      evt({ timestamp: '2026-05-05T10:00:00Z', actor: { id: 'b', display_name: 'Newest' } }),
      evt({ timestamp: '2026-05-03T10:00:00Z', actor: { id: 'c', display_name: 'Middle' } }),
      evt({ timestamp: '2026-05-04T10:00:00Z', actor: { id: 'd', display_name: 'Fourth' } }),
    ]);
    render();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Newest');
    expect(rows[1]).toHaveTextContent('Fourth');
    expect(rows[2]).toHaveTextContent('Middle');
    expect(screen.queryByText('Oldest')).not.toBeInTheDocument();
  });

  it('labels an authorless (system) event rather than rendering a blank actor', () => {
    mockFeed([evt({ actor: null, event_type: 'cpm_recalculated' })]);
    render();
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getByText('recalculated the schedule')).toBeInTheDocument();
  });

  it('drops a fields_changed entry with an empty diff so the trail never shows a no-op', () => {
    mockFeed([evt({ event_type: 'fields_changed', diff: [] })]);
    render();
    expect(screen.queryByTestId('drawer-recent-activity')).not.toBeInTheDocument();
  });

  it('hands off to the Activity tab from "View all"', () => {
    mockFeed([evt()]);
    const onViewAll = render();
    fireEvent.click(screen.getByTestId('drawer-recent-activity-view-all'));
    expect(onViewAll).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['loading', { data: undefined, isLoading: true, isError: false }],
    ['errored', { data: undefined, isLoading: false, isError: true }],
    ['empty', { data: { pages: [{ results: [], next: null }] }, isLoading: false, isError: false }],
  ])('renders nothing when the feed is %s', (_label, state) => {
    historySpy.mockReturnValue(state as MockHistoryResult);
    render();
    expect(screen.queryByTestId('drawer-recent-activity')).not.toBeInTheDocument();
  });
});
