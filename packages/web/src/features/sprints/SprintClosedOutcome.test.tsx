import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import userEvent from '@testing-library/user-event';

import { SprintClosedOutcome } from './SprintClosedOutcome';
import type { SprintOutcome } from '@/hooks/useSprints';

// Mock the review mutations so the component renders without a
// QueryClientProvider and we can assert the calls (#924, Wave D #1130-#1132).
const toggleMutate = vi.fn();
const reorderMutate = vi.fn();
const presenterMutate = vi.fn();
const noteMutate = vi.fn();
const flagMutate = vi.fn();
vi.mock('@/hooks/useSprints', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useSprints')>()),
  useToggleDemo: () => ({ mutate: toggleMutate, isPending: false, isError: false }),
  useReorderDemoList: () => ({ mutate: reorderMutate, isPending: false, isError: false }),
  useSetPresenter: () => ({ mutate: presenterMutate, isPending: false, isError: false }),
  useSetReviewNote: () => ({ mutate: noteMutate, isPending: false, isError: false }),
  useFlagForBacklog: () => ({ mutate: flagMutate, isPending: false, isError: false }),
}));

function shippedStory(
  over: Partial<SprintOutcome['review']['shipped'][number]> = {},
): SprintOutcome['review']['shipped'][number] {
  return {
    outcome_id: 'o1',
    task_id: 't9',
    task_short_id: 'T-200',
    task_title: 'Checkout flow',
    story_points: 8,
    acceptance: { met: 3, total: 3 },
    unmet_criteria: [],
    review_note: '',
    flagged_to_backlog: false,
    demo_ready: false,
    demo_order: 0,
    presenter: '',
    ...over,
  };
}

function review(overrides: Partial<SprintOutcome['review']> = {}): SprintOutcome['review'] {
  return {
    accepted_count: 1,
    not_accepted_count: 0,
    no_criteria_count: 0,
    accepted_points: 8,
    not_accepted_points: 0,
    shipped: [shippedStory()],
    demo_list: [],
    commitment: { committed_count: 12, shipped_count: 1, carried_count: 1 },
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
    // #1133: renamed coverage-hygiene labels (a state, not a grade).
    expect(sec).toHaveTextContent('2 criteria incomplete');
    expect(sec).toHaveTextContent('1 criteria not set');
    expect(sec).not.toHaveTextContent('not accepted');
    expect(sec).not.toHaveTextContent('no criteria');
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
            shipped: [shippedStory({ demo_ready: true, presenter: '' })],
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

describe('SprintClosedOutcome — Sprint Review polish (Wave D #1129–#1133)', () => {
  it('#1129: renders the committed → shipped → carried count line (always visible)', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          review: review({
            commitment: { committed_count: 6, shipped_count: 4, carried_count: 2 },
          }),
        })}
      />,
    );
    const line = screen.getByTestId('review-commitment-line');
    expect(line).toHaveTextContent('6');
    expect(line).toHaveTextContent('committed');
    expect(line).toHaveTextContent('shipped');
    expect(line).toHaveTextContent('carried over');
  });

  it('#1129: omits the carried clause on a provisional sprint (null carried)', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          review: review({
            commitment: { committed_count: 6, shipped_count: 2, carried_count: null },
          }),
        })}
      />,
    );
    expect(screen.getByTestId('review-commitment-line')).not.toHaveTextContent('carried over');
  });

  it('#1133: renders renamed labels for criteria-incomplete and criteria-not-set rows', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          review: review({
            shipped: [
              shippedStory({
                outcome_id: 'o-inc',
                task_short_id: 'T-301',
                task_title: 'Payment retries',
                acceptance: { met: 1, total: 2 },
                unmet_criteria: [{ id: 'ac1', text: 'Declined card handled' }],
              }),
              shippedStory({
                outcome_id: 'o-not',
                task_short_id: 'T-302',
                task_title: 'Receipt email',
                acceptance: { met: 0, total: 0 },
              }),
            ],
          }),
        })}
      />,
    );
    expect(screen.getByTestId('criteria-not-set')).toBeInTheDocument();
    // The "1/2 criteria" badge for the incomplete row is a disclosure toggle.
    expect(
      screen.getByRole('button', { name: /show incomplete criteria/i }),
    ).toBeInTheDocument();
  });

  it('#1131: discloses the specific unmet criteria when the badge is clicked', async () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          review: review({
            shipped: [
              shippedStory({
                outcome_id: 'o-inc',
                task_short_id: 'T-301',
                task_title: 'Payment retries',
                acceptance: { met: 1, total: 2 },
                unmet_criteria: [{ id: 'ac1', text: 'Declined card handled' }],
              }),
            ],
          }),
        })}
        canCurateDemo
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /show incomplete criteria/i }));
    expect(screen.getByTestId('unmet-criteria')).toHaveTextContent('Declined card handled');
  });

  it('#1131: a curator can leave an optional contributor note (fires set-note)', async () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          review: review({
            shipped: [
              shippedStory({
                outcome_id: 'o-not',
                task_id: 't-not',
                task_short_id: 'T-302',
                task_title: 'Receipt email',
                acceptance: { met: 0, total: 0 },
              }),
            ],
          }),
        })}
        canCurateDemo
      />,
    );
    const note = screen.getByPlaceholderText(/Optional note for reviewers/i);
    await userEvent.type(note, 'Refined next sprint');
    note.blur();
    expect(noteMutate).toHaveBeenCalledWith({ outcomeId: 'o-not', note: 'Refined next sprint' });
  });

  it('#1130: a curator sees a presenter input on a demo-flagged story (fires set-presenter)', async () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          review: review({
            demo_list: ['T-200'],
            shipped: [shippedStory({ demo_ready: true })],
          }),
        })}
        canCurateDemo
      />,
    );
    const input = screen.getByLabelText('Presenter');
    await userEvent.type(input, 'Alex');
    input.blur();
    expect(presenterMutate).toHaveBeenCalledWith({ outcomeId: 'o1', presenter: 'Alex' });
  });

  it('#1132: a flag-for-backlog button fires the mutation; flagged state shows after', () => {
    const { rerender } = render(
      <SprintClosedOutcome
        outcome={outcome({
          review: review({
            shipped: [
              shippedStory({
                outcome_id: 'o-not',
                task_id: 't-not',
                task_short_id: 'T-302',
                task_title: 'Receipt email',
                acceptance: { met: 0, total: 0 },
              }),
            ],
          }),
        })}
        canCurateDemo
      />,
    );
    screen.getByRole('button', { name: /Flag for backlog/i }).click();
    expect(flagMutate).toHaveBeenCalledWith({ outcomeId: 'o-not' });

    // After the server confirms, the row shows the flagged state instead of the button.
    rerender(
      <SprintClosedOutcome
        outcome={outcome({
          review: review({
            shipped: [
              shippedStory({
                outcome_id: 'o-not',
                task_id: 't-not',
                task_short_id: 'T-302',
                task_title: 'Receipt email',
                acceptance: { met: 0, total: 0 },
                flagged_to_backlog: true,
              }),
            ],
          }),
        })}
        canCurateDemo
      />,
    );
    expect(screen.getByTestId('flagged-state')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Flag for backlog/i })).toBeNull();
  });

  it('#1130: a read-only viewer sees the presenter but no curation controls', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          review: review({
            demo_list: ['T-200'],
            shipped: [shippedStory({ demo_ready: true, presenter: 'Jordan' })],
          }),
        })}
        canCurateDemo={false}
      />,
    );
    expect(screen.getByText(/Presenter:/i)).toHaveTextContent('Jordan');
    expect(screen.queryByLabelText('Presenter')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
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
