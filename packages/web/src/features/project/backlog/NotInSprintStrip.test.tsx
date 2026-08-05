import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '@/types';
import { NotInSprintStrip } from './NotInSprintStrip';

const h = vi.hoisted(() => ({ lower: 'sprint' }));
vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({
    singular: h.lower === 'sprint' ? 'Sprint' : 'Iteration',
    plural: h.lower === 'sprint' ? 'Sprints' : 'Iterations',
    lower: h.lower,
    lowerPlural: `${h.lower}s`,
    possessive: `${h.lower}'s`,
  }),
}));

function makeStory(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
    taskType: 'story',
    storyPoints: 2,
    sprintId: null,
    plannedStart: null,
    ...over,
  } as unknown as Task;
}

beforeEach(() => {
  h.lower = 'sprint';
  window.localStorage.clear();
});

describe('NotInSprintStrip', () => {
  it('counts stories with no sprint membership and how many of those are unestimated', () => {
    const stories = [
      makeStory('a', { name: 'Alpha', sprintId: 'sp1', storyPoints: 3 }),
      makeStory('b', { name: 'Bravo', sprintId: null, storyPoints: 2 }),
      makeStory('c', { name: 'Charlie', sprintId: null, storyPoints: null }),
    ];
    render(<NotInSprintStrip stories={stories} onSelect={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Not sprint-assigned' })).toBeInTheDocument();
    expect(screen.getByText('(2)')).toBeInTheDocument();
    expect(screen.getByText('1 unestimated')).toBeInTheDocument();
  });

  it('treats a plannedStart commitment the same as a sprint commitment (shared isTaskScheduled predicate)', () => {
    // A hybrid task tracked on the schedule (plannedStart set) but never pulled
    // into a sprint is still "committed" in the sense this strip cares about —
    // it should not appear in the not-assigned count, mirroring the waterfall
    // Unscheduled gutter's own "scheduled" definition (`@/lib/task.ts`).
    const stories = [makeStory('a', { name: 'Alpha', sprintId: null, plannedStart: '2026-09-01' })];
    render(<NotInSprintStrip stories={stories} onSelect={vi.fn()} />);
    expect(screen.getByText('(0)')).toBeInTheDocument();
  });

  it('uses the configured iteration label instead of a hard-coded "sprint"', () => {
    h.lower = 'iteration';
    const stories = [makeStory('a', { name: 'Alpha', sprintId: null })];
    render(<NotInSprintStrip stories={stories} onSelect={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Not iteration-assigned' })).toBeInTheDocument();
  });

  it('calls onSelect with the story id when a row is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const stories = [makeStory('a', { name: 'Alpha', sprintId: null })];
    render(<NotInSprintStrip stories={stories} onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /Alpha/ }));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('defaults to collapsed when every story already carries a sprint', () => {
    // Mirrors UnscheduledGutter: the reassurance message is a one-time
    // confirmation, not chrome worth showing forever on an already-committed
    // backlog — so a fully-committed backlog starts collapsed.
    const stories = [makeStory('a', { name: 'Alpha', sprintId: 'sp1' })];
    render(<NotInSprintStrip stories={stories} onSelect={vi.fn()} />);
    expect(screen.getByText('(0)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand Not sprint-assigned' })).toBeInTheDocument();
  });

  it('shows a reassurance message, not an empty list, once expanded with nothing to report', async () => {
    const user = userEvent.setup();
    const stories = [makeStory('a', { name: 'Alpha', sprintId: 'sp1' })];
    render(<NotInSprintStrip stories={stories} onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Expand Not sprint-assigned' }));
    expect(screen.getByText(/Every story carries a sprint/)).toBeInTheDocument();
  });

  it('persists the collapse toggle across remounts', async () => {
    const user = userEvent.setup();
    const stories = [makeStory('a', { name: 'Alpha', sprintId: null })];
    const { unmount } = render(<NotInSprintStrip stories={stories} onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Collapse Not sprint-assigned' }));
    expect(screen.queryByRole('button', { name: /Alpha/ })).not.toBeInTheDocument();
    unmount();

    render(<NotInSprintStrip stories={stories} onSelect={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Alpha/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand Not sprint-assigned' })).toBeInTheDocument();
  });
});
