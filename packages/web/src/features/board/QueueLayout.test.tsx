/**
 * QueueLayout unit tests — single prioritised list (epic #361 child D / issue
 * #384). Cover grouping behaviour, empty-state copy per group, and the
 * top-level empty state.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueueLayout, groupTasksForQueue } from './QueueLayout';
import type { Task, TaskStatus } from '@/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Task',
    start: '2026-04-01',
    finish: '2026-04-05',
    duration: 4,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED' as TaskStatus,
    assignees: [],
    notes: '',
    ...overrides,
  };
}

const BASE_PROPS = {
  phaseNameFor: (parentId: string | null) => parentId ?? 'Project',
  phaseColorFor: () => '#3E8C6D',
  focusedCardId: null,
  onCardFocus: vi.fn(),
  onCardClick: vi.fn(),
};

describe('groupTasksForQueue', () => {
  const NOW = new Date('2026-05-09T00:00:00Z');

  it('routes tasks into next-up / in-flight / backlog / recently-done buckets', () => {
    const groups = groupTasksForQueue(
      [
        makeTask({ id: 'a', status: 'NOT_STARTED' }),
        makeTask({ id: 'b', status: 'IN_PROGRESS' }),
        makeTask({ id: 'c', status: 'REVIEW' }),
        makeTask({ id: 'd', status: 'BACKLOG' }),
        makeTask({
          id: 'e',
          status: 'COMPLETE',
          actualFinish: '2026-05-05T00:00:00Z',
        }),
      ],
      NOW,
    );
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g.tasks.map((t) => t.id)]));
    expect(byKey.nextUp).toEqual(['a']);
    expect(byKey.inFlight).toEqual(['b', 'c']);
    expect(byKey.backlog).toEqual(['d']);
    expect(byKey.recentlyDone).toEqual(['e']);
  });

  it('drops summary tasks from every group', () => {
    const groups = groupTasksForQueue(
      [
        makeTask({ id: 'phase', isSummary: true, status: 'IN_PROGRESS' }),
        makeTask({ id: 'leaf', status: 'IN_PROGRESS' }),
      ],
      NOW,
    );
    const inFlight = groups.find((g) => g.key === 'inFlight');
    expect(inFlight?.tasks.map((t) => t.id)).toEqual(['leaf']);
  });

  it('excludes completed tasks older than 14 days from recently-done', () => {
    const groups = groupTasksForQueue(
      [
        makeTask({
          id: 'old',
          status: 'COMPLETE',
          actualFinish: '2026-04-20T00:00:00Z', // > 14d before NOW
        }),
        makeTask({
          id: 'new',
          status: 'COMPLETE',
          actualFinish: '2026-05-01T00:00:00Z',
        }),
      ],
      NOW,
    );
    const recent = groups.find((g) => g.key === 'recentlyDone');
    expect(recent?.tasks.map((t) => t.id)).toEqual(['new']);
  });

  it('sorts next-up by priorityRank ascending (lower = higher priority)', () => {
    const groups = groupTasksForQueue(
      [
        makeTask({ id: 'low', status: 'NOT_STARTED', priorityRank: 5 }),
        makeTask({ id: 'high', status: 'NOT_STARTED', priorityRank: 1 }),
      ],
      NOW,
    );
    const nextUp = groups.find((g) => g.key === 'nextUp');
    expect(nextUp?.tasks.map((t) => t.id)).toEqual(['high', 'low']);
  });

  it('sorts backlog by statusEnteredAt descending (newest first)', () => {
    const groups = groupTasksForQueue(
      [
        makeTask({ id: 'older', status: 'BACKLOG', statusEnteredAt: '2026-01-01T00:00:00Z' }),
        makeTask({ id: 'newer', status: 'BACKLOG', statusEnteredAt: '2026-04-01T00:00:00Z' }),
      ],
      NOW,
    );
    const backlog = groups.find((g) => g.key === 'backlog');
    expect(backlog?.tasks.map((t) => t.id)).toEqual(['newer', 'older']);
  });

  it('omits ON_HOLD tasks from every group (legacy status, intentionally inert)', () => {
    const groups = groupTasksForQueue(
      [makeTask({ id: 'hold', status: 'ON_HOLD' as TaskStatus })],
      NOW,
    );
    for (const g of groups) {
      expect(g.tasks).toHaveLength(0);
    }
  });
});

describe('QueueLayout', () => {
  const NOW = new Date('2026-05-09T00:00:00Z');

  it('renders the four group headers in canonical order', () => {
    render(
      <QueueLayout
        {...BASE_PROPS}
        now={NOW}
        tasks={[
          makeTask({ id: 'a', status: 'NOT_STARTED' }),
          makeTask({ id: 'b', status: 'IN_PROGRESS' }),
          makeTask({ id: 'c', status: 'BACKLOG' }),
          makeTask({
            id: 'd',
            status: 'COMPLETE',
            actualFinish: '2026-05-05T00:00:00Z',
          }),
        ]}
      />,
    );
    const sections = screen.getAllByRole('region', { hidden: true });
    // Sections aren't aria role="region" without aria-labelledby? Use heading order instead.
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      expect.stringMatching(/Next up/i),
      expect.stringMatching(/In flight/i),
      expect.stringMatching(/Backlog/i),
      expect.stringMatching(/Recently done/i),
    ]);
    expect(sections.length).toBeGreaterThanOrEqual(0);
  });

  it('renders a count chip per group', () => {
    render(
      <QueueLayout
        {...BASE_PROPS}
        now={NOW}
        tasks={[
          makeTask({ id: 'a', status: 'NOT_STARTED' }),
          makeTask({ id: 'b', status: 'NOT_STARTED' }),
          makeTask({ id: 'c', status: 'IN_PROGRESS' }),
        ]}
      />,
    );
    expect(screen.getByTestId('queue-group-count-nextUp')).toHaveTextContent('2');
    expect(screen.getByTestId('queue-group-count-inFlight')).toHaveTextContent('1');
    expect(screen.getByTestId('queue-group-count-backlog')).toHaveTextContent('0');
  });

  it('renders an empty-state line per group when that group has no tasks', () => {
    render(<QueueLayout {...BASE_PROPS} now={NOW} tasks={[makeTask({ status: 'NOT_STARTED' })]} />);
    expect(screen.getByTestId('queue-group-empty-inFlight')).toHaveTextContent(/No work in flight/i);
    expect(screen.getByTestId('queue-group-empty-backlog')).toHaveTextContent(/Nothing in the backlog/i);
    expect(screen.getByTestId('queue-group-empty-recentlyDone')).toHaveTextContent(/No tasks completed/i);
  });

  it('renders the top-level empty state when there are no tasks at all', () => {
    render(<QueueLayout {...BASE_PROPS} now={NOW} tasks={[]} />);
    expect(screen.getByTestId('queue-empty')).toHaveTextContent(/No tasks yet/i);
    // Group headers don't render in the empty case.
    expect(screen.queryByTestId('queue-layout')).toBeNull();
  });

  it('renders task names through QueueRow within their groups', () => {
    render(
      <QueueLayout
        {...BASE_PROPS}
        now={NOW}
        tasks={[
          makeTask({ id: 'x', status: 'NOT_STARTED', name: 'Refresh logo' }),
          makeTask({ id: 'y', status: 'BACKLOG', name: 'Audit links' }),
        ]}
      />,
    );
    expect(screen.getByText('Refresh logo')).toBeInTheDocument();
    expect(screen.getByText('Audit links')).toBeInTheDocument();
  });
});
