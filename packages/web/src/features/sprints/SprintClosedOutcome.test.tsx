import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SprintClosedOutcome } from './SprintClosedOutcome';
import type { SprintOutcome } from '@/hooks/useSprints';

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
    expect(screen.getByRole('status')).toHaveTextContent(/Everything committed shipped/i);
  });

  it('reports when membership was not recorded (pre-feature close)', () => {
    render(<SprintClosedOutcome outcome={outcome({ outcome_recorded: false, didnt_ship: [] })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/membership was not recorded/i);
  });
});
