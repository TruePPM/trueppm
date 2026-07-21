/**
 * QueueLayout unit tests — single prioritised list (epic #361 child D / issue
 * #384). Cover grouping behaviour, empty-state copy per group, and the
 * top-level empty state.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueueLayout, groupTasksForQueue, reorderGroupTasks } from './QueueLayout';
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

  // #2207: priority is a color-only cue (PriorityBars is aria-hidden), so the
  // rank must be folded into the row's accessible name for SR users.
  it('folds priority rank into the QueueRow accessible name', () => {
    render(
      <QueueLayout
        {...BASE_PROPS}
        now={NOW}
        tasks={[makeTask({ id: 'p', status: 'NOT_STARTED', name: 'Refresh logo', priorityRank: 5 })]}
      />,
    );
    expect(screen.getByRole('button', { name: /Refresh logo,.*, priority 5$/ })).toBeInTheDocument();
  });

  it('omits the priority suffix from the QueueRow name when unranked', () => {
    render(
      <QueueLayout
        {...BASE_PROPS}
        now={NOW}
        tasks={[makeTask({ id: 'p', status: 'NOT_STARTED', name: 'Refresh logo' })]}
      />,
    );
    expect(screen.getByTestId('queue-row-p').getAttribute('aria-label')).not.toMatch(/priority/);
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

describe('reorderGroupTasks', () => {
  const tasks = [
    makeTask({ id: 'a' }),
    makeTask({ id: 'b' }),
    makeTask({ id: 'c' }),
  ];

  it('promotes a row one slot (swaps with the previous)', () => {
    expect(reorderGroupTasks(tasks, 2, 1).map((t) => t.id)).toEqual(['a', 'c', 'b']);
  });

  it('demotes a row one slot (swaps with the next)', () => {
    expect(reorderGroupTasks(tasks, 0, 1).map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op when the target index is out of range', () => {
    expect(reorderGroupTasks(tasks, 0, -1)).toBe(tasks);
    expect(reorderGroupTasks(tasks, 2, 3)).toBe(tasks);
  });
});

describe('QueueRow overflow menu (issue 1610)', () => {
  const NOW = new Date('2026-05-09T00:00:00Z');

  it('replaces the former inert span with a real menu button per row', () => {
    render(
      <QueueLayout
        {...BASE_PROPS}
        now={NOW}
        canReorder
        onReorderGroup={vi.fn()}
        tasks={[makeTask({ id: 'a', status: 'NOT_STARTED', serverVersion: 1 })]}
      />,
    );
    const trigger = screen.getByTestId('queue-row-menu-a');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a role=menu with Promote / Demote / Open details for a reorderable middle row', async () => {
    const user = userEvent.setup();
    render(
      <QueueLayout
        {...BASE_PROPS}
        now={NOW}
        canReorder
        onReorderGroup={vi.fn()}
        tasks={[
          makeTask({ id: 'a', status: 'NOT_STARTED', priorityRank: 1, serverVersion: 1 }),
          makeTask({ id: 'b', status: 'NOT_STARTED', priorityRank: 2, serverVersion: 1 }),
          makeTask({ id: 'c', status: 'NOT_STARTED', priorityRank: 3, serverVersion: 1 }),
        ]}
      />,
    );
    await user.click(screen.getByTestId('queue-row-menu-b'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Promote/ })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: /Demote/ })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: /Open details/ })).toBeInTheDocument();
  });

  it('promote emits the group in its new order (moved row swapped up)', async () => {
    const user = userEvent.setup();
    const onReorderGroup = vi.fn();
    render(
      <QueueLayout
        {...BASE_PROPS}
        now={NOW}
        canReorder
        onReorderGroup={onReorderGroup}
        tasks={[
          makeTask({ id: 'a', status: 'NOT_STARTED', priorityRank: 1, serverVersion: 4 }),
          makeTask({ id: 'b', status: 'NOT_STARTED', priorityRank: 2, serverVersion: 7 }),
        ]}
      />,
    );
    await user.click(screen.getByTestId('queue-row-menu-b'));
    await user.click(screen.getByRole('menuitem', { name: /Promote/ }));
    expect(onReorderGroup).toHaveBeenCalledWith([
      { id: 'b', serverVersion: 7 },
      { id: 'a', serverVersion: 4 },
    ]);
  });

  it('disables Promote on the top row and Demote on the bottom row', async () => {
    const user = userEvent.setup();
    render(
      <QueueLayout
        {...BASE_PROPS}
        now={NOW}
        canReorder
        onReorderGroup={vi.fn()}
        tasks={[
          makeTask({ id: 'a', status: 'NOT_STARTED', priorityRank: 1, serverVersion: 1 }),
          makeTask({ id: 'b', status: 'NOT_STARTED', priorityRank: 2, serverVersion: 1 }),
        ]}
      />,
    );
    await user.click(screen.getByTestId('queue-row-menu-a'));
    expect(screen.getByRole('menuitem', { name: /Promote/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /Demote/ })).toBeEnabled();
  });

  it('omits Promote / Demote without the reorder capability, keeping Open details', async () => {
    const user = userEvent.setup();
    render(
      <QueueLayout
        {...BASE_PROPS}
        now={NOW}
        canReorder={false}
        onReorderGroup={vi.fn()}
        tasks={[makeTask({ id: 'a', status: 'NOT_STARTED', serverVersion: 1 })]}
      />,
    );
    await user.click(screen.getByTestId('queue-row-menu-a'));
    expect(screen.queryByRole('menuitem', { name: /Promote/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Demote/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Open details/ })).toBeInTheDocument();
  });

  it('does not offer Promote / Demote on the Backlog group (sorted by recency, not priority)', async () => {
    const user = userEvent.setup();
    render(
      <QueueLayout
        {...BASE_PROPS}
        now={NOW}
        canReorder
        onReorderGroup={vi.fn()}
        tasks={[makeTask({ id: 'bk', status: 'BACKLOG', serverVersion: 1 })]}
      />,
    );
    await user.click(screen.getByTestId('queue-row-menu-bk'));
    expect(screen.queryByRole('menuitem', { name: /Promote/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Open details/ })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <QueueLayout
        {...BASE_PROPS}
        now={NOW}
        canReorder
        onReorderGroup={vi.fn()}
        tasks={[makeTask({ id: 'a', status: 'NOT_STARTED', serverVersion: 1 })]}
      />,
    );
    await user.click(screen.getByTestId('queue-row-menu-a'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('demote emits the group with the moved row swapped one slot down', async () => {
    const user = userEvent.setup();
    const onReorderGroup = vi.fn();
    render(
      <QueueLayout
        {...BASE_PROPS}
        now={NOW}
        canReorder
        onReorderGroup={onReorderGroup}
        tasks={[
          makeTask({ id: 'a', status: 'NOT_STARTED', priorityRank: 1, serverVersion: 4 }),
          makeTask({ id: 'b', status: 'NOT_STARTED', priorityRank: 2, serverVersion: 7 }),
        ]}
      />,
    );
    // Demote the TOP row → it swaps below the second, yielding [b, a].
    await user.click(screen.getByTestId('queue-row-menu-a'));
    await user.click(screen.getByRole('menuitem', { name: /Demote/ }));
    expect(onReorderGroup).toHaveBeenCalledWith([
      { id: 'b', serverVersion: 7 },
      { id: 'a', serverVersion: 4 },
    ]);
  });

  it('omits Promote / Demote when canReorder is set but no onReorderGroup handler is wired', async () => {
    const user = userEvent.setup();
    render(
      <QueueLayout
        {...BASE_PROPS}
        now={NOW}
        canReorder
        tasks={[makeTask({ id: 'a', status: 'NOT_STARTED', serverVersion: 1 })]}
      />,
    );
    await user.click(screen.getByTestId('queue-row-menu-a'));
    expect(screen.queryByRole('menuitem', { name: /Promote/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Open details/ })).toBeInTheDocument();
  });
});

describe('QueueLayout row callbacks', () => {
  const NOW = new Date('2026-05-09T00:00:00Z');

  it('reports focus with the task id, status, and phase id (root when unparented)', () => {
    const onCardFocus = vi.fn();
    render(
      <QueueLayout
        {...BASE_PROPS}
        onCardFocus={onCardFocus}
        now={NOW}
        tasks={[makeTask({ id: 'a', status: 'IN_PROGRESS', parentId: null, name: 'Free task' })]}
      />,
    );
    screen.getByRole('button', { name: /^Free task,/ }).focus();
    expect(onCardFocus).toHaveBeenCalledWith('a', 'IN_PROGRESS', 'root');
  });

  it('reports focus with the parent id as the phase id when the task is nested', () => {
    const onCardFocus = vi.fn();
    render(
      <QueueLayout
        {...BASE_PROPS}
        onCardFocus={onCardFocus}
        now={NOW}
        tasks={[
          makeTask({ id: 'a', status: 'NOT_STARTED', parentId: 'phase-9', name: 'Nested task' }),
        ]}
      />,
    );
    screen.getByRole('button', { name: /^Nested task,/ }).focus();
    expect(onCardFocus).toHaveBeenCalledWith('a', 'NOT_STARTED', 'phase-9');
  });

  it('forwards a row click to onCardClick with the task and its anchor element', async () => {
    const user = userEvent.setup();
    const onCardClick = vi.fn();
    render(
      <QueueLayout
        {...BASE_PROPS}
        onCardClick={onCardClick}
        now={NOW}
        tasks={[makeTask({ id: 'a', status: 'NOT_STARTED', name: 'Click me' })]}
      />,
    );
    const button = screen.getByRole('button', { name: /^Click me,/ });
    await user.click(button);
    expect(onCardClick).toHaveBeenCalledTimes(1);
    expect(onCardClick.mock.calls[0][0]).toMatchObject({ id: 'a' });
    expect(onCardClick.mock.calls[0][1]).toBe(button);
  });
});

describe('groupTasksForQueue sort tie-breakers', () => {
  const NOW = new Date('2026-05-09T00:00:00Z');

  it('breaks equal priorityRank by statusEnteredAt (newer first) in next-up', () => {
    const nextUp = groupTasksForQueue(
      [
        makeTask({
          id: 'older',
          status: 'NOT_STARTED',
          priorityRank: 2,
          statusEnteredAt: '2026-01-01T00:00:00Z',
        }),
        makeTask({
          id: 'newer',
          status: 'NOT_STARTED',
          priorityRank: 2,
          statusEnteredAt: '2026-04-01T00:00:00Z',
        }),
      ],
      NOW,
    ).find((g) => g.key === 'nextUp');
    expect(nextUp?.tasks.map((t) => t.id)).toEqual(['newer', 'older']);
  });

  it('breaks equal priorityRank AND equal statusEnteredAt by name in next-up', () => {
    const nextUp = groupTasksForQueue(
      [
        makeTask({ id: 'b', name: 'Beta', status: 'NOT_STARTED', priorityRank: 1, statusEnteredAt: '2026-01-01T00:00:00Z' }),
        makeTask({ id: 'a', name: 'Alpha', status: 'NOT_STARTED', priorityRank: 1, statusEnteredAt: '2026-01-01T00:00:00Z' }),
      ],
      NOW,
    ).find((g) => g.key === 'nextUp');
    expect(nextUp?.tasks.map((t) => t.name)).toEqual(['Alpha', 'Beta']);
  });

  it('breaks equal statusEnteredAt by name in the backlog group', () => {
    const backlog = groupTasksForQueue(
      [
        makeTask({ id: 'z', name: 'Zebra', status: 'BACKLOG', statusEnteredAt: '2026-01-01T00:00:00Z' }),
        makeTask({ id: 'a', name: 'Apple', status: 'BACKLOG', statusEnteredAt: '2026-01-01T00:00:00Z' }),
      ],
      NOW,
    ).find((g) => g.key === 'backlog');
    expect(backlog?.tasks.map((t) => t.name)).toEqual(['Apple', 'Zebra']);
  });

  it('falls back to `finish` for recently-done when actualFinish is absent', () => {
    const recent = groupTasksForQueue(
      [
        makeTask({ id: 'usesFinish', status: 'COMPLETE', actualFinish: undefined, finish: '2026-05-02' }),
      ],
      NOW,
    ).find((g) => g.key === 'recentlyDone');
    // No actualFinish, but `finish` is inside the 14-day window → included.
    expect(recent?.tasks.map((t) => t.id)).toEqual(['usesFinish']);
  });

  it('sorts recently-done by finish date descending, breaking ties by name', () => {
    const recent = groupTasksForQueue(
      [
        makeTask({ id: 'early', name: 'B', status: 'COMPLETE', actualFinish: '2026-05-01T00:00:00Z' }),
        makeTask({ id: 'late', name: 'A', status: 'COMPLETE', actualFinish: '2026-05-06T00:00:00Z' }),
        makeTask({ id: 'tieA', name: 'A', status: 'COMPLETE', actualFinish: '2026-05-06T00:00:00Z' }),
      ],
      NOW,
    ).find((g) => g.key === 'recentlyDone');
    // Newest finish first (late/tieA), and the two equal-finish tasks order by name.
    expect(recent?.tasks.map((t) => t.id)).toEqual(['late', 'tieA', 'early']);
  });

  it('excludes a COMPLETE task with an unparseable / missing finish date (NaN guard)', () => {
    const recent = groupTasksForQueue(
      [makeTask({ id: 'noDate', status: 'COMPLETE', actualFinish: undefined, finish: '' })],
      NOW,
    ).find((g) => g.key === 'recentlyDone');
    expect(recent?.tasks).toHaveLength(0);
  });
});

describe('reorderGroupTasks from === to', () => {
  it('returns the same array reference when source and target index are identical', () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b' })];
    expect(reorderGroupTasks(tasks, 1, 1)).toBe(tasks);
  });
});
