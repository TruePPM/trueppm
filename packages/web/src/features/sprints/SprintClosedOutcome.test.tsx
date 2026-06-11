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
    milestone_slip: null,
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
    // #1097: rolled over is the carried-disposition sum (5), NOT the committed−completed
    // proxy (34−28=6) that used to contradict the disposition list.
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByLabelText(/Velocity up 4 points/i)).toBeInTheDocument();
  });

  it('#1097: drives Rolled over from carried points, not committed−completed', () => {
    // Scope was injected mid-sprint: 3 carried tasks (8 pts) + drops, so the proxy
    // (34−28=6) disagrees with the disposition list. The headline must equal the
    // carried sum (8) so it can never contradict the breakdown below it.
    render(
      <SprintClosedOutcome
        outcome={outcome({
          didnt_ship_summary: {
            carried_count: 3,
            carried_points: 8,
            dropped_count: 2,
            dropped_points: 9,
          },
        })}
      />,
    );
    expect(screen.getByText('8')).toBeInTheDocument(); // carried sum
    expect(screen.queryByText('6')).toBeNull(); // never the proxy
  });

  it('#1097: shows — for rolled over when disposition was not recorded (pre-#982)', () => {
    render(<SprintClosedOutcome outcome={outcome({ outcome_recorded: false, didnt_ship: [] })} />);
    // The rolled-over card falls to "—" rather than a derived guess.
    const cards = screen.getAllByText('—');
    expect(cards.length).toBeGreaterThan(0);
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

describe('SprintClosedOutcome — milestone slip line (#1098)', () => {
  const slip = (over: Partial<NonNullable<SprintOutcome['milestone_slip']>> = {}) => ({
    milestone_id: 'm1',
    milestone_name: 'Login redesign',
    milestone_short_id: 'T-9',
    slip_days: 12,
    baseline_finish: '2026-05-01',
    forecast_finish: '2026-05-13',
    basis: 'forecast' as const,
    ...over,
  });

  it('pairs rolled-over points with the milestone slip in one line', () => {
    render(<SprintClosedOutcome outcome={outcome({ milestone_slip: slip() })} />);
    const line = screen.getByTestId('milestone-slip-line');
    expect(line).toHaveTextContent('Rolled over 5 pts');
    expect(line).toHaveTextContent('Login redesign');
    expect(line).toHaveTextContent('now +12d vs baseline');
  });

  it('hides the line when no milestone slip is present', () => {
    render(<SprintClosedOutcome outcome={outcome({ milestone_slip: null })} />);
    expect(screen.queryByTestId('milestone-slip-line')).toBeNull();
  });

  it('reads as "ahead of baseline" when the milestone is early', () => {
    render(<SprintClosedOutcome outcome={outcome({ milestone_slip: slip({ slip_days: -3 }) })} />);
    expect(screen.getByTestId('milestone-slip-line')).toHaveTextContent('3d ahead of baseline');
  });

  it('uses past-tense "finished" copy once the milestone has actually finished', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({ milestone_slip: slip({ basis: 'actual', slip_days: 4 }) })}
      />,
    );
    expect(screen.getByTestId('milestone-slip-line')).toHaveTextContent('finished 4d late vs baseline');
  });

  it('drops the points clause but keeps the slip when points are velocity-suppressed', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          milestone_slip: slip(),
          velocity: null,
          didnt_ship_summary: {
            carried_count: 1,
            carried_points: null,
            dropped_count: 0,
            dropped_points: null,
          },
        })}
      />,
    );
    const line = screen.getByTestId('milestone-slip-line');
    expect(line).not.toHaveTextContent('Rolled over');
    expect(line).toHaveTextContent('now +12d vs baseline');
  });
});
