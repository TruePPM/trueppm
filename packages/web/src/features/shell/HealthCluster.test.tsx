import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { FIXTURE_SHELL_STATS } from '@/fixtures/shellStats';
import type { ShellStats, ApiSprint, Methodology } from '@/types';
import type { ProjectVelocity } from '@/hooks/useSprints';
import { HealthCluster } from './HealthCluster';

vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'test-project-id' }));

const mockNavigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const methodology = vi.hoisted<{ current: Methodology }>(() => ({ current: 'WATERFALL' }));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({
    data: { id: 'p', methodology: methodology.current },
    isLoading: false,
    error: null,
  }),
}));

const stats = vi.hoisted<{ current: ShellStats | undefined }>(() => ({ current: undefined }));
vi.mock('@/hooks/useShellStats', () => ({
  useShellStats: () => ({ data: stats.current, isLoading: false, error: null }),
}));

const activeSprint = vi.hoisted<{ current: ApiSprint | null }>(() => ({ current: null }));
const velocity = vi.hoisted<{ current: ProjectVelocity | undefined }>(() => ({
  current: undefined,
}));
vi.mock('@/hooks/useSprints', () => ({
  useActiveSprint: () => ({ sprint: activeSprint.current, isLoading: false }),
  useProjectVelocity: () => ({ data: velocity.current, isLoading: false, error: null }),
}));

vi.mock('@/hooks/useIterationLabel', () => ({
  useIterationLabel: () => ({
    singular: 'Sprint',
    plural: 'Sprints',
    lower: 'sprint',
    lowerPlural: 'sprints',
    possessive: "Sprint's",
  }),
}));

// The current-sprint jump targets folded into the popover (#1680). Configurable
// per test; default empty (the sprint row then falls back to the sprints list).
type SprintTarget = {
  projectId: string;
  projectName: string;
  sprintId: string;
  sprintName: string;
  path: string;
};
const sprintTargets = vi.hoisted<{ current: SprintTarget[] }>(() => ({ current: [] }));
vi.mock('@/hooks/useCurrentSprintTargets', () => ({
  useCurrentSprintTargets: () => sprintTargets.current,
}));

const mcResult = vi.hoisted<{ current: { p50: string; p80: string; p95: string } | undefined }>(
  () => ({ current: { p50: '2026-10-05', p80: '2026-11-03', p95: '2026-11-30' } }),
);
// Spread the canonical fixture so the mock is a structurally complete
// MonteCarloResult (cpmFinish/deltaVsCpm/confidenceCurve/sensitivity), not a bare
// percentile triple — an incomplete mock would mask any read of those fields
// (#1365). Async factory: vi.mock is hoisted above imports, so import the fixture
// inside the factory rather than referencing a top-level import binding.
vi.mock('@/hooks/useMonteCarloResult', async () => {
  const { FIXTURE_MC_RESULT } = await import('@/fixtures/monteCarlo');
  return {
    useMonteCarloResult: () => ({
      data: mcResult.current
        ? { ...FIXTURE_MC_RESULT, projectId: 'p', runs: 1000, ...mcResult.current, buckets: [] }
        : undefined,
      isLoading: false,
      error: null,
    }),
  };
});

vi.mock('@/hooks/useMonteCarloHistory', () => ({
  useMonteCarloHistory: () => ({
    data: [],
    cap: 100,
    // ForecastHistorySection gates on `enabled === false`; include it so the mock
    // matches UseMonteCarloHistoryReturn and the section renders in its real
    // enabled state rather than an undefined-gated one (#1365).
    enabled: true,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

function makeSprint(over: Partial<ApiSprint>): ApiSprint {
  return {
    name: 'Sprint 7',
    start_date: '2026-06-08',
    finish_date: '2026-06-19',
    committed_points: 40,
    completed_points: 32,
    committed_task_count: 18,
    completed_task_count: 12,
    ...over,
  } as ApiSprint;
}

const VELOCITY: ProjectVelocity = {
  sprints: [],
  rolling_avg_points: 24,
  rolling_stdev_points: 4,
  forecast_range_low: 18,
  forecast_range_high: 30,
  rolling_avg_tasks: null,
  rolling_stdev_tasks: null,
  team_velocity_per_day: 2.4,
  excluded_count: 0,
};

beforeEach(() => {
  methodology.current = 'WATERFALL';
  stats.current = FIXTURE_SHELL_STATS;
  activeSprint.current = makeSprint({});
  velocity.current = VELOCITY;
  mcResult.current = { p50: '2026-10-05', p80: '2026-11-03', p95: '2026-11-30' };
  sprintTargets.current = [];
  mockNavigate.mockClear();
});

function render() {
  return renderWithRouter(<HealthCluster onTaskNavigate={vi.fn()} />, {
    initialEntries: ['/projects/test-project-id/board'],
  });
}

/** Open the health popover and return its dialog node. */
async function openPopover(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('health-cluster'));
  return screen.getByRole('dialog', { name: 'Project health' });
}

describe('HealthCluster', () => {
  it('renders the status chip trigger with the health-cluster testid', () => {
    render();
    const chip = screen.getByTestId('health-cluster');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
  });

  // (a) state-word mapping ---------------------------------------------------

  it('chip reads "On track" when there are no at-risk or critical tasks', () => {
    stats.current = { ...FIXTURE_SHELL_STATS, atRiskCount: 0, criticalCount: 0 };
    render();
    expect(screen.getByTestId('health-cluster')).toHaveTextContent('On track');
  });

  it('chip reads "On watch" when at-risk > 0 and critical = 0', () => {
    stats.current = { ...FIXTURE_SHELL_STATS, atRiskCount: 3, criticalCount: 0 };
    render();
    expect(screen.getByTestId('health-cluster')).toHaveTextContent('On watch');
  });

  it('chip reads "At risk" when there is at least one critical task', () => {
    stats.current = { ...FIXTURE_SHELL_STATS, atRiskCount: 0, criticalCount: 1 };
    render();
    expect(screen.getByTestId('health-cluster')).toHaveTextContent('At risk');
  });

  it('AGILE project with a critical task still reads "At risk" on the chip', () => {
    // The AGILE cluster has no critical segment, but the chip word derives from
    // the project-wide count on useShellStats — so a real critical task surfaces.
    methodology.current = 'AGILE';
    stats.current = { ...FIXTURE_SHELL_STATS, atRiskCount: 0, criticalCount: 2 };
    render();
    expect(screen.getByTestId('health-cluster')).toHaveTextContent('At risk');
  });

  // (b) chip P80 fragment ----------------------------------------------------

  it('chip omits the P80 fragment for AGILE (no forecast segment)', () => {
    methodology.current = 'AGILE';
    render();
    expect(screen.getByTestId('health-cluster')).not.toHaveTextContent('P80');
  });

  it('chip shows "P80 —" for WATERFALL when no forecast has run', () => {
    methodology.current = 'WATERFALL';
    stats.current = { ...FIXTURE_SHELL_STATS, monteCarlop80: null };
    mcResult.current = undefined;
    render();
    const chip = screen.getByTestId('health-cluster');
    expect(chip).toHaveTextContent('P80');
    expect(chip).toHaveTextContent('—');
  });

  it('chip shows the P80 date when a forecast is available', () => {
    methodology.current = 'WATERFALL';
    render();
    const chip = screen.getByTestId('health-cluster');
    expect(chip).toHaveTextContent('P80');
    expect(chip).toHaveTextContent('Nov 3'); // 2026-11-03 in UTC
  });

  // (c) popover row set matches methodology -----------------------------------

  it('WATERFALL popover has forecast (P50 + P80) + at-risk + critical rows', async () => {
    const user = userEvent.setup();
    methodology.current = 'WATERFALL';
    render();
    const dialog = await openPopover(user);
    expect(within(dialog).getByText('Forecast P50')).toBeInTheDocument();
    expect(within(dialog).getByText('Forecast P80')).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: /2 at-risk tasks/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: /1 critical task$/i })).toBeInTheDocument();
  });

  it('AGILE popover has sprint + points + velocity rows', async () => {
    const user = userEvent.setup();
    methodology.current = 'AGILE';
    render();
    const dialog = await openPopover(user);
    expect(within(dialog).getByText('Sprint 7')).toBeInTheDocument();
    expect(within(dialog).getByText(/Day \d+\/\d+/)).toBeInTheDocument();
    expect(within(dialog).getByText('32/40')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: /velocity 24 points per sprint/i }),
    ).toBeInTheDocument();
  });

  it('HYBRID popover has sprint + forecast + critical rows, no at-risk', async () => {
    const user = userEvent.setup();
    methodology.current = 'HYBRID';
    render();
    const dialog = await openPopover(user);
    expect(within(dialog).getByText('Sprint 7')).toBeInTheDocument();
    expect(within(dialog).getByText('Forecast P80')).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: /1 critical task$/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: /at-risk/i })).not.toBeInTheDocument();
  });

  // (d) velocity privacy wall — NO number ------------------------------------

  it('AGILE velocity row is a content-free privacy wall when suppressed (ADR-0104, rule 168)', async () => {
    const user = userEvent.setup();
    methodology.current = 'AGILE';
    velocity.current = { ...VELOCITY, velocity_suppressed: true };
    render();
    const dialog = await openPopover(user);
    expect(within(dialog).getByText(/kept to the team/i)).toBeInTheDocument();
    // The number is never rendered.
    expect(within(dialog).queryByText(/24/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /velocity 24/i })).not.toBeInTheDocument();
  });

  // (e) forecast rows are neutral (never amber/critical) ----------------------

  it('forecast rows carry no amber/critical text class (rule 172 — informational, neutral)', async () => {
    const user = userEvent.setup();
    methodology.current = 'WATERFALL';
    render();
    const dialog = await openPopover(user);
    const p50Row = within(dialog).getByText('Forecast P50').closest('div')!;
    const p80Row = within(dialog).getByText('Forecast P80').closest('div')!;
    for (const row of [p50Row, p80Row]) {
      expect(row.className).not.toMatch(/semantic-at-risk|semantic-critical/);
      expect(row.innerHTML).not.toMatch(/semantic-at-risk|semantic-critical/);
    }
  });

  // (c continued) forecast band + degrade ------------------------------------

  it('forecast P80 row shows "—" when the scheduler has not run', async () => {
    const user = userEvent.setup();
    methodology.current = 'WATERFALL';
    stats.current = { ...FIXTURE_SHELL_STATS, monteCarlop80: null };
    mcResult.current = undefined;
    render();
    const dialog = await openPopover(user);
    const p80Row = within(dialog).getByText('Forecast P80').closest('div')!;
    expect(within(p80Row).getByText('—')).toBeInTheDocument();
    // No MC result cached → no Details drill.
    expect(within(dialog).queryByRole('button', { name: /monte carlo/i })).not.toBeInTheDocument();
  });

  it('clicking the forecast "Details ›" row opens the MC distribution panel', async () => {
    const user = userEvent.setup();
    methodology.current = 'WATERFALL';
    render();
    const dialog = await openPopover(user);
    await user.click(within(dialog).getByRole('button', { name: /monte carlo forecast/i }));
    expect(screen.getByRole('dialog', { name: /monte carlo confidence/i })).toBeInTheDocument();
  });

  it('at-risk row drills into the offending tasks and closes the popover', async () => {
    const user = userEvent.setup();
    const onTaskNavigate = vi.fn();
    methodology.current = 'WATERFALL';
    renderWithRouter(<HealthCluster onTaskNavigate={onTaskNavigate} />, {
      initialEntries: ['/projects/test-project-id/board'],
    });
    await user.click(screen.getByTestId('health-cluster'));
    const dialog = screen.getByRole('dialog', { name: 'Project health' });
    await user.click(within(dialog).getByRole('button', { name: /frontend build/i }));
    expect(onTaskNavigate).toHaveBeenCalledWith('t4');
    // Drilling closes the popover.
    expect(screen.queryByRole('dialog', { name: 'Project health' })).not.toBeInTheDocument();
  });

  // (f) sprint-row jump — the folded-in CurrentSprintButton (#1680) --------------

  it('sprint row jumps to the in-context sprint board when a target exists (#1680)', async () => {
    const user = userEvent.setup();
    methodology.current = 'AGILE';
    sprintTargets.current = [
      {
        projectId: 'test-project-id',
        projectName: 'This project',
        sprintId: 's1',
        sprintName: 'Sprint 7',
        path: '/projects/test-project-id/board?sprint=s1',
      },
    ];
    render();
    const dialog = await openPopover(user);
    // The primary row's accessible name now reads "Go to sprint board".
    await user.click(
      within(dialog).getByRole('button', {
        name: /sprint 7, day \d+ of \d+\. go to sprint board/i,
      }),
    );
    expect(mockNavigate).toHaveBeenCalledWith('/projects/test-project-id/board?sprint=s1');
  });

  it('sprint row falls back to the sprints list until a board target resolves', async () => {
    const user = userEvent.setup();
    methodology.current = 'AGILE';
    sprintTargets.current = []; // not resolved yet
    render();
    const dialog = await openPopover(user);
    await user.click(within(dialog).getByRole('button', { name: /sprint 7, day \d+ of \d+/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/test-project-id/sprints');
  });

  it('multi-team: cross-team sprints render as per-team jump rows in a group (#1680)', async () => {
    const user = userEvent.setup();
    methodology.current = 'AGILE';
    sprintTargets.current = [
      {
        projectId: 'test-project-id',
        projectName: 'This project',
        sprintId: 's1',
        sprintName: 'Sprint 7',
        path: '/projects/test-project-id/board?sprint=s1',
      },
      {
        projectId: 'other',
        projectName: 'Payments platform',
        sprintId: 's2',
        sprintName: 'Sprint 12',
        path: '/projects/other/board?sprint=s2',
      },
    ];
    render();
    const dialog = await openPopover(user);
    const group = within(dialog).getByRole('group', { name: /other teams' active sprints/i });
    await user.click(
      within(group).getByRole('button', { name: /go to payments platform sprint: sprint 12/i }),
    );
    expect(mockNavigate).toHaveBeenCalledWith('/projects/other/board?sprint=s2');
  });

  it('no cross-team group when there is only the in-context sprint', async () => {
    const user = userEvent.setup();
    methodology.current = 'AGILE';
    sprintTargets.current = [
      {
        projectId: 'test-project-id',
        projectName: 'This project',
        sprintId: 's1',
        sprintName: 'Sprint 7',
        path: '/projects/test-project-id/board?sprint=s1',
      },
    ];
    render();
    const dialog = await openPopover(user);
    expect(
      within(dialog).queryByRole('group', { name: /other teams' active sprints/i }),
    ).not.toBeInTheDocument();
  });

  // (h) Esc closes + refocuses trigger ---------------------------------------

  it('Escape closes the popover and returns focus to the chip trigger', async () => {
    const user = userEvent.setup();
    render();
    const chip = screen.getByTestId('health-cluster');
    await user.click(chip);
    expect(screen.getByRole('dialog', { name: 'Project health' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Project health' })).not.toBeInTheDocument();
    expect(chip).toHaveFocus();
  });

  // (g) project-scoped suppression -------------------------------------------

  it('is suppressed on a project settings route (rule 123 / ADR-0128 §C)', () => {
    const { container } = renderWithRouter(<HealthCluster onTaskNavigate={vi.fn()} />, {
      initialEntries: ['/projects/test-project-id/settings/general'],
    });
    expect(container.firstChild).toBeNull();
  });
});
