import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CarryoverLane } from './CarryoverLane';
import type { CarryoverItem } from '@/hooks/useSprints';

const state = vi.hoisted(() => ({
  data: undefined as CarryoverItem[] | undefined,
  isLoading: false,
  isPending: false,
}));
const mutate = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useSprints', () => ({
  useProjectRetroCarryover: () => ({ data: state.data, isLoading: state.isLoading }),
  usePullCarryoverToSprint: () => ({ mutate, isPending: state.isPending }),
}));
vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({ lower: 'iteration', singular: 'Iteration', plural: 'Iterations' }),
}));

function item(overrides: Partial<CarryoverItem> = {}): CarryoverItem {
  return {
    action_item_id: 'a1',
    text: 'Write the runbook',
    from_retro_id: 'r1',
    from_sprint_id: 's0',
    from_sprint_short_id: 'S3',
    promoted_task_id: 't1',
    promoted_task_status: 'NOT_STARTED',
    promoted_task_short_id: 'RIV-07',
    age_days: 12,
    assignee_id: null,
    assignee_username: null,
    story_points: 3,
    ...overrides,
  };
}

beforeEach(() => {
  mutate.mockReset();
  state.data = [
    item(),
    item({
      action_item_id: 'a2',
      text: 'Trim standup',
      promoted_task_short_id: null,
      story_points: null,
    }),
  ];
  state.isLoading = false;
  state.isPending = false;
});

describe('CarryoverLane', () => {
  it('suppresses itself while loading or when there is nothing to carry over', () => {
    state.isLoading = true;
    const { container, rerender } = render(<CarryoverLane projectId="p1" sprintId="s1" canPull />);
    expect(container).toBeEmptyDOMElement();
    state.isLoading = false;
    state.data = [];
    rerender(<CarryoverLane projectId="p1" sprintId="s1" canPull />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the items with short id, points and age, and pulls into the planned sprint', async () => {
    const user = userEvent.setup();
    render(<CarryoverLane projectId="p1" sprintId="s1" canPull />);
    expect(screen.getByRole('heading', { name: /From last retro/ })).toHaveTextContent('2');
    expect(screen.getByText('T-RIV-07')).toBeInTheDocument();
    expect(screen.getByText('3pts')).toBeInTheDocument();
    expect(screen.getAllByText('12d')).toHaveLength(2);
    // A row whose item was never promoted, and has no estimate, shows dashes.
    expect(screen.getByText('—pts')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(1);

    const buttons = screen.getAllByRole('button', { name: 'Pull to iteration' });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]);
    expect(mutate).toHaveBeenCalledWith({ itemId: 'a2', targetSprintId: 's1' });
  });

  it('is read-only below Scheduler, and disables Pull while a pull is in flight', () => {
    const { rerender } = render(<CarryoverLane projectId="p1" sprintId="s1" canPull={false} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getAllByText('View only')).toHaveLength(2);

    state.isPending = true;
    rerender(<CarryoverLane projectId="p1" sprintId="s1" canPull />);
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
  });
});
