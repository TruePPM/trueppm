import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SprintClosedOutcome } from './SprintClosedOutcome';
import type { SprintOutcome } from '@/hooks/useSprints';

// Mock only the demo-toggle mutation so the component renders without a
// QueryClientProvider and we can assert the toggle call (#924).
const toggleMutate = vi.fn();
vi.mock('@/hooks/useSprints', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useSprints')>()),
  useToggleDemo: () => ({ mutate: toggleMutate, isPending: false, isError: false }),
}));

function review(overrides: Partial<SprintOutcome['review']> = {}): SprintOutcome['review'] {
  return {
    accepted_count: 1,
    not_accepted_count: 0,
    no_criteria_count: 0,
    accepted_points: 8,
    not_accepted_points: 0,
    shipped: [
      {
        outcome_id: 'o1',
        task_id: 't9',
        task_short_id: 'T-200',
        task_title: 'Checkout flow',
        story_points: 8,
        acceptance: { met: 3, total: 3 },
        demo_ready: false,
      },
    ],
    demo_list: [],
    ...overrides,
  };
}

function outcome(overrides: Partial<SprintOutcome> = {}): SprintOutcome {
  return {
    sprint_id: 's1',
    state: 'COMPLETED',
    provisional: false,
    outcome_recorded: true,
    name: 'Sprint 7',
    start_date: '2026-04-01',
    finish_date: '2026-04-14',
    closed_at: '2026-04-14T00:00:00Z',
    goal: 'Ship checkout',
    goal_outcome: 'MET',
    commitment: {
      committed_points: 34,
      committed_task_count: 12,
      completed_points: 28,
      completed_task_count: 9,
      completion_ratio_points: 0.82,
      completion_ratio_tasks: 0.75,
    },
    velocity: {
      completed_points: 28,
      velocity_delta_points: 4,
      rolling_avg_points: 25,
      burn_status: 'behind',
      trend_points: -3,
      projected_finish_date: null,
    },
    didnt_ship: [
      {
        task_id: 't1',
        task_short_id: 'T-101',
        task_title: 'Refresh-token rotation',
        story_points: 5,
        final_status: 'IN_PROGRESS',
        disposition: 'carried',
        next_sprint_id: 's2',
        next_sprint_name: 'Sprint 8',
        was_pending: false,
      },
    ],
    didnt_ship_summary: { carried_count: 1, carried_points: 5, dropped_count: 0, dropped_points: 0 },
    retro_summary: null,
    review: review(),
    ...overrides,
  };
}

describe('SprintClosedOutcome (#567)', () => {
  it('renders the 5-card outcome row from the /outcome/ payload', () => {
    render(<SprintClosedOutcome outcome={outcome()} />);
    expect(screen.getByLabelText(/Goal Met/i)).toBeInTheDocument();
    expect(screen.getByText('34')).toBeInTheDocument(); // committed
    expect(screen.getByText('28')).toBeInTheDocument(); // completed
    expect(screen.getByText('(82%)')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument(); // rolled over = 34-28
    expect(screen.getByLabelText(/Velocity up 4 points/i)).toBeInTheDocument();
  });

  it('lists what didn\'t ship with the carried-to-sprint chip', () => {
    render(<SprintClosedOutcome outcome={outcome()} />);
    const list = screen.getByTestId('didnt-ship');
    expect(list).toHaveTextContent('T-101');
    expect(list).toHaveTextContent('Refresh-token rotation');
    expect(list).toHaveTextContent('→ Sprint 8');
    expect(list).toHaveTextContent('5 pts');
  });

  it('hides per-task points when suppressed (velocity gated)', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          velocity: null,
          didnt_ship: [{ ...outcome().didnt_ship[0], story_points: null }],
        })}
      />,
    );
    expect(screen.getByTestId('didnt-ship')).not.toHaveTextContent('pts');
    // The velocity Δ card shows a dash when the block is suppressed.
    expect(screen.queryByLabelText(/Velocity (up|down)/i)).toBeNull();
  });

  it('shows the everything-shipped empty state', () => {
    render(<SprintClosedOutcome outcome={outcome({ didnt_ship: [], didnt_ship_summary: { carried_count: 0, carried_points: 0, dropped_count: 0, dropped_points: 0 } })} />);
    expect(screen.getByText(/Everything committed shipped/i)).toBeInTheDocument();
  });

  it('reports when membership was not recorded (pre-feature close)', () => {
    render(<SprintClosedOutcome outcome={outcome({ outcome_recorded: false, didnt_ship: [] })} />);
    expect(screen.getByText(/membership was not recorded/i)).toBeInTheDocument();
  });
});

describe('SprintClosedOutcome — Sprint Review breakdown (#924)', () => {
  it('renders the accepted-vs-not breakdown and a no-criteria coverage signal', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          review: review({ accepted_count: 4, not_accepted_count: 2, no_criteria_count: 1 }),
        })}
      />,
    );
    const sec = screen.getByTestId('sprint-review');
    expect(sec).toHaveTextContent('4 accepted');
    expect(sec).toHaveTextContent('2 not accepted');
    expect(sec).toHaveTextContent('1 no criteria');
  });

  it('shows a shipped story with its acceptance badge', () => {
    render(<SprintClosedOutcome outcome={outcome()} />);
    const sec = screen.getByTestId('sprint-review');
    expect(sec).toHaveTextContent('T-200');
    expect(sec).toHaveTextContent('Checkout flow');
    expect(sec).toHaveTextContent('3/3 criteria');
  });

  it('renders the demo toggle for a curator and fires the mutation', async () => {
    render(<SprintClosedOutcome outcome={outcome()} canCurateDemo />);
    const toggle = screen.getByRole('switch', { name: /Add to demo list: Checkout flow/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    expect(toggleMutate).toHaveBeenCalledWith({ outcomeId: 'o1', demoReady: true });
  });

  it('hides the demo toggle for a read-only viewer, showing only a marker on demo items', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          review: review({
            demo_list: ['T-200'],
            shipped: [{ ...review().shipped[0], demo_ready: true }],
          }),
        })}
        canCurateDemo={false}
      />,
    );
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/In the demo list/i)).toBeInTheDocument();
  });

  it('gates accepted points behind the velocity audience (counts stay)', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({ review: review({ accepted_count: 3, accepted_points: null }) })}
      />,
    );
    const sec = screen.getByTestId('sprint-review');
    expect(sec).toHaveTextContent('3 accepted');
    expect(screen.getByTestId('accepted-count')).not.toHaveTextContent('pts');
  });
});
