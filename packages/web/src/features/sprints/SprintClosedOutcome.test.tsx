import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, render as rtlRender } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
// SprintClosedOutcome's ShippedRow reads useParams() (issue 1617 — "+ Add
// criteria" now routes to the task drawer instead of a dead hash link), so
// this suite needs a Router context, not just QueryClientProvider. Uses the
// wrapper-based helper (not renderWithRouter) because several tests below
// call `rerender` with a new SprintClosedOutcome element directly.
import { renderWithProvidersAndRouter as render } from '@/test/utils';
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
// Mutable mutation state so a handful of tests can exercise the pending/error
// branches (the disabled toggle and the "Couldn't update the demo list" alert).
// Defaults are reset to a happy/idle state before every test.
const mutationState = { toggleIsPending: false, toggleIsError: false, reorderIsError: false };
vi.mock('@/hooks/useSprints', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useSprints')>()),
  useToggleDemo: () => ({
    mutate: toggleMutate,
    isPending: mutationState.toggleIsPending,
    isError: mutationState.toggleIsError,
  }),
  useReorderDemoList: () => ({
    mutate: reorderMutate,
    isPending: false,
    isError: mutationState.reorderIsError,
  }),
  useSetPresenter: () => ({ mutate: presenterMutate, isPending: false, isError: false }),
  useSetReviewNote: () => ({ mutate: noteMutate, isPending: false, isError: false }),
  useFlagForBacklog: () => ({ mutate: flagMutate, isPending: false, isError: false }),
}));

beforeEach(() => {
  toggleMutate.mockClear();
  reorderMutate.mockClear();
  presenterMutate.mockClear();
  noteMutate.mockClear();
  flagMutate.mockClear();
  mutationState.toggleIsPending = false;
  mutationState.toggleIsError = false;
  mutationState.reorderIsError = false;
});

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

// Renders at a real /projects/:projectId/sprints route so useParams()
// resolves — needed to assert the "+ Add criteria" link href (issue 1617).
function renderAtProjectRoute(ui: ReactElement, projectId: string) {
  const testQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const testRouter = createMemoryRouter([{ path: '/projects/:projectId/sprints', element: ui }], {
    initialEntries: [`/projects/${projectId}/sprints`],
  });
  return rtlRender(
    <QueryClientProvider client={testQueryClient}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
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

  it('issue 1617: "+ Add criteria" links to the task detail route, not a dead hash link', () => {
    renderAtProjectRoute(
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
      'proj-42',
    );
    const link = screen.getByRole('link', { name: /add criteria/i });
    expect(link).toHaveAttribute('href', '/projects/proj-42/tasks/t-not');
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

  it('reads "now on baseline" when the forecast lands exactly on baseline (slip 0)', () => {
    render(<SprintClosedOutcome outcome={outcome({ milestone_slip: slip({ slip_days: 0 }) })} />);
    const line = screen.getByTestId('milestone-slip-line');
    expect(line).toHaveTextContent('now on baseline');
    // The sr-only band for an on-baseline milestone.
    expect(line).toHaveTextContent('(on baseline)');
  });

  it('reads "finished on baseline" once actually finished exactly on baseline', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({ milestone_slip: slip({ basis: 'actual', slip_days: 0 }) })}
      />,
    );
    expect(screen.getByTestId('milestone-slip-line')).toHaveTextContent('finished on baseline');
  });

  it('reads "finished Xd ahead" once actually finished early (basis actual, negative slip)', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({ milestone_slip: slip({ basis: 'actual', slip_days: -2 }) })}
      />,
    );
    const line = screen.getByTestId('milestone-slip-line');
    expect(line).toHaveTextContent('finished 2d ahead of baseline');
    expect(line).toHaveTextContent('(ahead of schedule)');
  });

  it('tags a small slip (≤5d) as the amber "at risk" band, not critical', () => {
    render(<SprintClosedOutcome outcome={outcome({ milestone_slip: slip({ slip_days: 3 }) })} />);
    const line = screen.getByTestId('milestone-slip-line');
    expect(line).toHaveTextContent('now +3d vs baseline');
    expect(line).toHaveTextContent('(at risk)');
    expect(line.className).toContain('semantic-at-risk');
  });

  it('tags a large slip (>5d) as the red "critical slip" band', () => {
    render(<SprintClosedOutcome outcome={outcome({ milestone_slip: slip({ slip_days: 12 }) })} />);
    const line = screen.getByTestId('milestone-slip-line');
    expect(line).toHaveTextContent('(critical slip)');
    expect(line.className).toContain('semantic-critical');
  });

  it('omits the rolled-over clause when carried points are zero', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          milestone_slip: slip(),
          didnt_ship_summary: {
            carried_count: 0,
            carried_points: 0,
            dropped_count: 1,
            dropped_points: 4,
          },
        })}
      />,
    );
    expect(screen.getByTestId('milestone-slip-line')).not.toHaveTextContent('Rolled over');
  });
});

describe('SprintClosedOutcome — GoalVerdict + Velocity Δ tones', () => {
  it('renders a PARTIAL goal verdict with the half glyph', () => {
    render(<SprintClosedOutcome outcome={outcome({ goal_outcome: 'PARTIAL' })} />);
    const verdict = screen.getByLabelText('Goal Partial');
    expect(verdict).toHaveTextContent('Partial');
    expect(verdict.className).toContain('semantic-at-risk');
  });

  it('renders a MISSED goal verdict with the critical tone', () => {
    render(<SprintClosedOutcome outcome={outcome({ goal_outcome: 'MISSED' })} />);
    const verdict = screen.getByLabelText('Goal Missed');
    expect(verdict).toHaveTextContent('Missed');
    expect(verdict.className).toContain('semantic-critical');
  });

  it('shows a dash for the goal card when no verdict was recorded (null)', () => {
    render(<SprintClosedOutcome outcome={outcome({ goal_outcome: null })} />);
    expect(screen.queryByLabelText(/^Goal /)).toBeNull();
  });

  it('renders a velocity DROP as the amber down-arrow signal', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          velocity: { ...outcome().velocity!, velocity_delta_points: -6 },
        })}
      />,
    );
    const delta = screen.getByLabelText(/Velocity down 6 points/i);
    expect(delta).toHaveTextContent('-6');
    expect(delta.className).toContain('semantic-at-risk');
  });

  it('renders an unchanged velocity Δ with the neutral marker', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          velocity: { ...outcome().velocity!, velocity_delta_points: 0 },
        })}
      />,
    );
    const delta = screen.getByLabelText(/Velocity unchanged/i);
    expect(delta).toHaveTextContent('0');
  });

  it('hides the completion ratio when the server sends none (null)', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          commitment: { ...outcome().commitment, completion_ratio_points: null },
        })}
      />,
    );
    // No "(NN%)" chip when the ratio is null.
    expect(screen.queryByText(/\(\d+%\)/)).toBeNull();
  });
});

describe('SprintClosedOutcome — didn\'t-ship dispositions (#1097)', () => {
  const item = (over: Partial<SprintOutcome['didnt_ship'][number]> = {}) => ({
    task_id: 't1',
    task_short_id: 'T-101',
    task_title: 'Refresh-token rotation',
    story_points: 5,
    final_status: 'IN_PROGRESS',
    disposition: 'carried' as const,
    next_sprint_id: 's2',
    next_sprint_name: 'Sprint 8',
    was_pending: false,
    ...over,
  });

  it('renders a "dropped" chip and the dropped count in the header', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          didnt_ship: [item({ task_short_id: 'T-500', disposition: 'dropped' })],
          didnt_ship_summary: {
            carried_count: 0,
            carried_points: 0,
            dropped_count: 1,
            dropped_points: 5,
          },
        })}
      />,
    );
    const list = screen.getByTestId('didnt-ship');
    expect(list).toHaveTextContent('dropped');
    expect(list).toHaveTextContent('1 dropped');
    expect(list).not.toHaveTextContent('carried');
  });

  it('falls back to "next sprint" when the carry target has no name yet', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          didnt_ship: [item({ next_sprint_id: null, next_sprint_name: null })],
        })}
      />,
    );
    expect(screen.getByTestId('didnt-ship')).toHaveTextContent('→ next sprint');
  });

  it('renders no disposition chip for an item that was neither carried nor dropped', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          didnt_ship: [
            item({
              task_short_id: 'T-600',
              task_title: 'Untriaged item',
              disposition: 'none' as unknown as 'carried',
            }),
          ],
        })}
      />,
    );
    const list = screen.getByTestId('didnt-ship');
    expect(list).toHaveTextContent('Untriaged item');
    expect(list).not.toHaveTextContent('dropped');
    expect(list).not.toHaveTextContent('→');
  });
});

describe('SprintClosedOutcome — shipped-list edges + curation errors', () => {
  it('shows the empty "no stories shipped" state when nothing shipped', () => {
    render(<SprintClosedOutcome outcome={outcome({ review: review({ shipped: [] }) })} />);
    expect(screen.getByText(/No stories shipped this sprint/i)).toBeInTheDocument();
  });

  it('omits the commitment line entirely when committed_count is null', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          review: review({
            commitment: { committed_count: null, shipped_count: 0, carried_count: null },
          }),
        })}
      />,
    );
    expect(screen.queryByTestId('review-commitment-line')).toBeNull();
  });

  it('lets a curator remove an already-demoed story (fires toggle with false)', async () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({ review: review({ shipped: [shippedStory({ demo_ready: true })] }) })}
        canCurateDemo
      />,
    );
    const toggle = screen.getByRole('switch', { name: /Remove from demo list: Checkout flow/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);
    expect(toggleMutate).toHaveBeenCalledWith({ outcomeId: 'o1', demoReady: false });
  });

  it('disables the demo toggle while a toggle mutation is pending', () => {
    mutationState.toggleIsPending = true;
    render(<SprintClosedOutcome outcome={outcome()} canCurateDemo />);
    expect(screen.getByRole('switch', { name: /demo list/i })).toBeDisabled();
  });

  it('surfaces the demo-list error alert when the toggle mutation failed', () => {
    mutationState.toggleIsError = true;
    render(<SprintClosedOutcome outcome={outcome()} canCurateDemo />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't update the demo list/i);
  });

  it('does not re-fire set-note when the note is blurred unchanged', () => {
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
                review_note: 'Existing note',
              }),
            ],
          }),
        })}
        canCurateDemo
      />,
    );
    const note = screen.getByPlaceholderText(/Optional note for reviewers/i);
    note.focus();
    note.blur();
    expect(noteMutate).not.toHaveBeenCalled();
  });
});

describe('SprintClosedOutcome — demo reorder (curator, ≥2 demo stories) #1130', () => {
  const twoDemo = () =>
    outcome({
      review: review({
        shipped: [
          shippedStory({
            outcome_id: 'o-a',
            task_short_id: 'T-1',
            task_title: 'Alpha story',
            demo_ready: true,
            demo_order: 0,
          }),
          shippedStory({
            outcome_id: 'o-b',
            task_short_id: 'T-2',
            task_title: 'Beta story',
            demo_ready: true,
            demo_order: 1,
          }),
        ],
      }),
    });

  it('renders drag handles and the reorder hint once there are 2+ demo stories', () => {
    render(<SprintClosedOutcome outcome={twoDemo()} canCurateDemo />);
    const sec = screen.getByTestId('sprint-review');
    expect(sec).toHaveTextContent('2 for demo');
    expect(sec).toHaveTextContent(/Drag the ⠿ handle to set demo order/i);
    // One reorder handle per demo-flagged story.
    expect(screen.getByRole('button', { name: /Reorder demo: Alpha story/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reorder demo: Beta story/i })).toBeInTheDocument();
  });

  it('does not render drag handles for a read-only viewer even with 2 demo stories', () => {
    render(<SprintClosedOutcome outcome={twoDemo()} canCurateDemo={false} />);
    expect(screen.queryByRole('button', { name: /Reorder demo:/i })).toBeNull();
    expect(screen.getByTestId('sprint-review')).not.toHaveTextContent('Drag the ⠿ handle');
  });

  it('surfaces the error alert when the reorder mutation failed', () => {
    mutationState.reorderIsError = true;
    render(<SprintClosedOutcome outcome={twoDemo()} canCurateDemo />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't update the demo list/i);
  });

  it('wires the demo toggle and presenter input on a sortable row', async () => {
    render(<SprintClosedOutcome outcome={twoDemo()} canCurateDemo />);
    // Toggle off the first demo story from within the sortable list path.
    await userEvent.click(
      screen.getByRole('switch', { name: /Remove from demo list: Alpha story/i }),
    );
    expect(toggleMutate).toHaveBeenCalledWith({ outcomeId: 'o-a', demoReady: false });

    // Presenter blur on a sortable demo-flagged row fires set-presenter.
    const presenters = screen.getAllByLabelText('Presenter');
    await userEvent.type(presenters[0], 'Sam');
    presenters[0].blur();
    expect(presenterMutate).toHaveBeenCalledWith({ outcomeId: 'o-a', presenter: 'Sam' });
  });

  it('wires note + flag-for-backlog on a demo-flagged, criteria-incomplete sortable row', () => {
    render(
      <SprintClosedOutcome
        outcome={outcome({
          review: review({
            shipped: [
              shippedStory({
                outcome_id: 'o-a',
                task_short_id: 'T-1',
                task_title: 'Alpha story',
                demo_ready: true,
                acceptance: { met: 1, total: 2 },
                unmet_criteria: [{ id: 'ac1', text: 'Edge case' }],
              }),
              shippedStory({
                outcome_id: 'o-b',
                task_short_id: 'T-2',
                task_title: 'Beta story',
                demo_ready: true,
              }),
            ],
          }),
        })}
        canCurateDemo
      />,
    );
    // The flag-for-backlog button on the sortable incomplete row fires the mutation.
    screen.getByRole('button', { name: /Flag for backlog/i }).click();
    expect(flagMutate).toHaveBeenCalledWith({ outcomeId: 'o-a' });
  });
});
