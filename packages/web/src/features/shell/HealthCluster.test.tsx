import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { FIXTURE_SHELL_STATS } from '@/fixtures/shellStats';
import type { ShellStats, ApiSprint, Methodology, AddedTimeFacts } from '@/types';
import { ADDED_TIME_FIXTURES } from '@/fixtures/addedTime';
import type { ProjectVelocity } from '@/hooks/useSprints';
import { HealthCluster } from './HealthCluster';

// Configurable per test: `null` models an off-project route (My Work,
// Notifications, workspace settings), where the chip is suppressed entirely.
const projectId = vi.hoisted<{ current: string | null }>(() => ({ current: 'test-project-id' }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => projectId.current }));

const mockNavigate = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const methodology = vi.hoisted<{ current: Methodology }>(() => ({ current: 'WATERFALL' }));
// `projectLoaded: false` models the pre-load tick, where the component falls back
// to the richest (HYBRID) cluster.
const projectLoaded = vi.hoisted<{ current: boolean }>(() => ({ current: true }));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({
    data: projectLoaded.current ? { id: 'p', methodology: methodology.current } : undefined,
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

// `p50`/`p80` are nullable so a "distribution cached but no P80" run can be
// modelled (the forecast band then reads "P80 not run").
const mcResult = vi.hoisted<{
  current: { p50: string | null; p80: string | null; p95: string } | undefined;
}>(() => ({ current: { p50: '2026-10-05', p80: '2026-11-03', p95: '2026-11-30' } }));
// Spread the canonical fixture so the mock is a structurally complete
// MonteCarloResult (cpmFinish/deltaVsCpm/confidenceCurve/sensitivity), not a bare
// percentile triple — an incomplete mock would mask any read of those fields
// (#1365). Async factory: vi.mock is hoisted above imports, so import the fixture
// inside the factory rather than referencing a top-level import binding.
// Added time (#2531): the premium slice the shell now reads off the same payload,
// plus the two non-settled query states — an in-flight or failed forecast read must
// suppress the row rather than let an undefined premium assert "Not run yet".
const riskPremium = vi.hoisted<{ current: AddedTimeFacts | undefined }>(() => ({
  current: undefined,
}));
const mcLoading = vi.hoisted<{ current: boolean }>(() => ({ current: false }));
const mcErrored = vi.hoisted<{ current: boolean }>(() => ({ current: false }));
vi.mock('@/hooks/useMonteCarloResult', async () => {
  const { FIXTURE_MC_RESULT } = await import('@/fixtures/monteCarlo');
  return {
    useMonteCarloResult: () => ({
      data: mcResult.current
        ? {
            ...FIXTURE_MC_RESULT,
            projectId: 'p',
            runs: 1000,
            ...mcResult.current,
            buckets: [],
            riskPremium: riskPremium.current,
          }
        : undefined,
      isLoading: mcLoading.current,
      error: mcErrored.current ? new Error('forecast read failed') : null,
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
  projectId.current = 'test-project-id';
  projectLoaded.current = true;
  methodology.current = 'WATERFALL';
  stats.current = FIXTURE_SHELL_STATS;
  activeSprint.current = makeSprint({});
  velocity.current = VELOCITY;
  mcResult.current = { p50: '2026-10-05', p80: '2026-11-03', p95: '2026-11-30' };
  sprintTargets.current = [];
  riskPremium.current = undefined;
  mcLoading.current = false;
  mcErrored.current = false;
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

  // (i) viewport-clamped portaled popover (rule 253, #1969) -------------------

  it('portals the popover to document.body and positions it fixed', async () => {
    const user = userEvent.setup();
    render();
    const dialog = await openPopover(user);
    // No longer an in-flow descendant of the chip wrapper — it lives on body so
    // it can escape any clipping ancestor and clamp to the viewport.
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.style.position).toBe('fixed');
  });

  it('clamps the popover to the viewport so it never clips off the left edge on a phone', async () => {
    const user = userEvent.setup();
    render();
    const trigger = screen.getByTestId('health-cluster');
    // Simulate a narrow phone: the chip's right edge sits mid-bar at 240 in a
    // 375px viewport. Right-anchored, a >=260px panel would run to left:-20 and
    // clip — the exact bug (#1969). The clamp must pin left to the 8px margin.
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: 12,
      bottom: 46,
      left: 206,
      right: 240,
      width: 34,
      height: 34,
      x: 206,
      y: 12,
      toJSON: () => ({}),
    } as DOMRect);
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true, writable: true });

    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Project health' });
    const left = Number.parseFloat(dialog.style.left);
    expect(left).toBeGreaterThanOrEqual(8); // never past the left edge
    expect(left).toBeLessThanOrEqual(375 - 8); // fully on-screen
    expect(dialog.style.top).toBe('50px'); // rect.bottom (46) + 4px gap

    Object.defineProperty(window, 'innerWidth', {
      value: originalWidth,
      configurable: true,
      writable: true,
    });
  });

  it('click inside the portaled popover keeps it open; outside click closes it', async () => {
    const user = userEvent.setup();
    methodology.current = 'WATERFALL';
    render();
    const dialog = await openPopover(user);
    // A click on a non-interactive spot inside the panel must not close it, even
    // though the panel is no longer a DOM descendant of the chip wrapper.
    await user.click(within(dialog).getByText('Forecast P50'));
    expect(screen.getByRole('dialog', { name: 'Project health' })).toBeInTheDocument();
    // A click outside closes it.
    await user.click(document.body);
    expect(screen.queryByRole('dialog', { name: 'Project health' })).not.toBeInTheDocument();
  });

  // (g) project-scoped suppression -------------------------------------------

  it('is suppressed on a project settings route (rule 123 / ADR-0128 §C)', () => {
    const { container } = renderWithRouter(<HealthCluster onTaskNavigate={vi.fn()} />, {
      initialEntries: ['/projects/test-project-id/settings/general'],
    });
    expect(container.firstChild).toBeNull();
  });

  it('is suppressed entirely off a project route', () => {
    projectId.current = null;
    const { container } = renderWithRouter(<HealthCluster onTaskNavigate={vi.fn()} />, {
      initialEntries: ['/my-work'],
    });
    expect(container.firstChild).toBeNull();
  });
});

describe('HealthCluster degraded / edge reads', () => {
  it('falls back to the richest (HYBRID) cluster until the project loads', async () => {
    const user = userEvent.setup();
    projectLoaded.current = false;
    methodology.current = 'AGILE'; // ignored — no project data to read it from
    render();
    const dialog = await openPopover(user);
    // HYBRID = sprint + forecast + critical.
    expect(within(dialog).getByText('Sprint 7')).toBeInTheDocument();
    expect(within(dialog).getByText('Forecast P80')).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: /critical task/i })).toBeInTheDocument();
  });

  it('reads "On track" with 0-task drills when the shell stats have not arrived', async () => {
    const user = userEvent.setup();
    stats.current = undefined;
    methodology.current = 'WATERFALL';
    render();
    expect(screen.getByTestId('health-cluster')).toHaveTextContent('On track');
    const dialog = await openPopover(user);
    // Both drill rows collapse to the calm static "0 tasks" read — no group, no
    // task buttons.
    expect(within(dialog).getAllByText('0 tasks')).toHaveLength(2);
    expect(within(dialog).queryByRole('group')).not.toBeInTheDocument();
  });

  it('caps the at-risk drill at five tasks with a "+N more" tail', async () => {
    const user = userEvent.setup();
    methodology.current = 'WATERFALL';
    stats.current = {
      ...FIXTURE_SHELL_STATS,
      atRiskCount: 7,
      atRiskTasks: Array.from({ length: 7 }, (_, i) => ({
        id: `t${i}`,
        wbs: `1.${i}`,
        name: `At-risk task ${i}`,
      })),
    };
    render();
    const dialog = await openPopover(user);
    const group = within(dialog).getByRole('group', { name: '7 at-risk tasks' });
    expect(within(group).getAllByRole('button')).toHaveLength(5);
    expect(within(group).getByText('+2 more')).toBeInTheDocument();
  });

  it('pluralizes the drill group labels off the count', async () => {
    const user = userEvent.setup();
    methodology.current = 'WATERFALL';
    stats.current = {
      ...FIXTURE_SHELL_STATS,
      atRiskCount: 1,
      atRiskTasks: [{ id: 'a1', wbs: '1.1', name: 'Only at-risk' }],
      criticalCount: 2,
      criticalTasks: [
        { id: 'c1', wbs: '2.1', name: 'Critical one' },
        { id: 'c2', wbs: '2.2', name: 'Critical two' },
      ],
    };
    render();
    const dialog = await openPopover(user);
    expect(within(dialog).getByRole('group', { name: '1 at-risk task' })).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: '2 critical tasks' })).toBeInTheDocument();
  });

  it('forecast Details announces "P80 not run" when only a P50 is cached', async () => {
    const user = userEvent.setup();
    methodology.current = 'WATERFALL';
    stats.current = { ...FIXTURE_SHELL_STATS, monteCarlop80: null };
    mcResult.current = { p50: '2026-10-05', p80: null, p95: '2026-11-30' };
    render();
    const dialog = await openPopover(user);
    expect(
      within(dialog).getByRole('button', {
        name: 'Monte Carlo forecast: P50 Oct 5, P80 not run. View distribution.',
      }),
    ).toBeInTheDocument();
    // The P50 slot still carries its date; the P80 slot degrades to an em dash.
    const p50Row = within(dialog).getByText('Forecast P50').closest('div')!;
    expect(within(p50Row).getByText('Oct 5')).toBeInTheDocument();
    const p80Row = within(dialog).getByText('Forecast P80').closest('div')!;
    expect(within(p80Row).getByText('—')).toBeInTheDocument();
  });

  it('closes the MC distribution panel from its own close control', async () => {
    const user = userEvent.setup();
    methodology.current = 'WATERFALL';
    render();
    const dialog = await openPopover(user);
    await user.click(within(dialog).getByRole('button', { name: /monte carlo forecast/i }));
    const panel = screen.getByRole('dialog', { name: /monte carlo confidence/i });
    await user.click(within(panel).getByRole('button', { name: /close monte carlo panel/i }));
    expect(
      screen.queryByRole('dialog', { name: /monte carlo confidence/i }),
    ).not.toBeInTheDocument();
  });

  // --- AGILE segment edges --------------------------------------------------

  it('points row reads items when the team sizes in counts rather than points', async () => {
    const user = userEvent.setup();
    methodology.current = 'AGILE';
    activeSprint.current = makeSprint({ committed_points: null, completed_points: null });
    render();
    const dialog = await openPopover(user);
    const row = within(dialog).getByLabelText('12 of 18 items completed');
    expect(within(row).getByText('12/18')).toBeInTheDocument();
    expect(within(row).getByText('items')).toBeInTheDocument();
  });

  it('velocity row is a calm em dash until there is closed-sprint history', async () => {
    const user = userEvent.setup();
    methodology.current = 'AGILE';
    velocity.current = { ...VELOCITY, rolling_avg_points: null };
    render();
    const dialog = await openPopover(user);
    // No number, no jump button — just the muted read.
    expect(within(dialog).queryByRole('button', { name: /velocity/i })).not.toBeInTheDocument();
    const row = within(dialog).getByText('Velocity').closest('div')!;
    expect(within(row).getByText('—')).toBeInTheDocument();
  });

  it('velocity aria omits the range when the forecast band is missing and names excluded sprints', async () => {
    const user = userEvent.setup();
    methodology.current = 'AGILE';
    velocity.current = {
      ...VELOCITY,
      forecast_range_low: null,
      forecast_range_high: null,
      excluded_count: 2,
    };
    render();
    const dialog = await openPopover(user);
    const button = within(dialog).getByRole('button', { name: /velocity 24 points per sprint/i });
    expect(button.getAttribute('aria-label')).toBe(
      'Velocity 24 points per sprint, 2 excluded. Visible to project members only — not on portfolio dashboards. View sprints.',
    );
    await user.click(button);
    expect(mockNavigate).toHaveBeenCalledWith('/projects/test-project-id/sprints');
  });

  it('no active sprint: the empty row routes to the sprints list, cross-team jumps remain', async () => {
    const user = userEvent.setup();
    methodology.current = 'AGILE';
    activeSprint.current = null;
    sprintTargets.current = [
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
    // Other teams' sprints are still reachable while this project has none.
    const group = within(dialog).getByRole('group', { name: /other teams' active sprints/i });
    expect(within(group).getByText('Sprint 12')).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole('button', { name: 'No active sprint. View sprints.' }),
    );
    expect(mockNavigate).toHaveBeenCalledWith('/projects/test-project-id/sprints');
    expect(screen.queryByRole('dialog', { name: 'Project health' })).not.toBeInTheDocument();
  });
});

/**
 * Added time in the context bar (#2531).
 *
 * The defect this closes: added time rendered on Overview and *nowhere else*, so a
 * user on Schedule, Board or Table had no pointer to it at all.
 */
describe('HealthCluster added time', () => {
  function renderAt(pathname: string) {
    return renderWithRouter(<HealthCluster onTaskNavigate={vi.fn()} />, {
      initialEntries: [pathname],
    });
  }

  const P = '/projects/test-project-id';

  beforeEach(() => {
    riskPremium.current = ADDED_TIME_FIXTURES.premium;
  });

  describe('rule 284 — one value, one render per screen', () => {
    it('is suppressed on Overview, where AddedTimeCard already carries it', async () => {
      const user = userEvent.setup();
      renderAt(`${P}/overview`);

      expect(screen.getByTestId('health-cluster')).not.toHaveTextContent('Added');
      const dialog = await openPopover(user);
      expect(within(dialog).queryByText('Added time')).not.toBeInTheDocument();
    });

    it('is suppressed on the bare project route, which resolves to Overview', () => {
      renderAt(P);
      expect(screen.getByTestId('health-cluster')).not.toHaveTextContent('Added');
    });

    it('renders on Board, where nothing else on screen carries it', async () => {
      const user = userEvent.setup();
      renderAt(`${P}/board`);
      const dialog = await openPopover(user);
      expect(within(dialog).getByText('Added time')).toBeInTheDocument();
    });
  });

  describe('the popover row is never dropped — it is what fixes "no pointer at all"', () => {
    it('carries the delta with its baseline named, because the popover shows no computed finish', async () => {
      const user = userEvent.setup();
      renderAt(`${P}/board`);
      const dialog = await openPopover(user);
      expect(dialog).toHaveTextContent('+11d vs Oct 24');
    });

    it('renders "needs estimates" for an unmeasurable project, never a calm number', async () => {
      riskPremium.current = ADDED_TIME_FIXTURES.unmeasurable;
      const user = userEvent.setup();
      renderAt(`${P}/board`);
      const dialog = await openPopover(user);

      expect(within(dialog).getByText('needs estimates')).toBeInTheDocument();
      expect(dialog).not.toHaveTextContent('+0d');
      expect(dialog).not.toHaveTextContent('0d');
    });

    it('states a measured zero in words, so it stays distinct from the unmeasurable one', async () => {
      riskPremium.current = ADDED_TIME_FIXTURES.zero;
      const user = userEvent.setup();
      renderAt(`${P}/board`);
      const dialog = await openPopover(user);
      expect(within(dialog).getByText('No added time')).toBeInTheDocument();
    });

    it('says "Not run yet" rather than a dash for a project with no forecast', async () => {
      riskPremium.current = ADDED_TIME_FIXTURES.notRun;
      const user = userEvent.setup();
      renderAt(`${P}/board`);
      const dialog = await openPopover(user);
      expect(within(dialog).getByText('Not run yet')).toBeInTheDocument();
    });

    it('stamps a stale premium with the date it was measured — the one place A3 allows it', async () => {
      riskPremium.current = ADDED_TIME_FIXTURES.stale;
      const user = userEvent.setup();
      renderAt(`${P}/board`);
      const dialog = await openPopover(user);
      expect(dialog).toHaveTextContent('as of Jul 14');
    });

    it('sits directly after the forecast rows, not below the task drill lists', async () => {
      const user = userEvent.setup();
      renderAt(`${P}/board`);
      const dialog = await openPopover(user);

      // A delta separated from its baseline by a dozen expandable task rows is the
      // #2426 defect. Position is load-bearing, so it is asserted, not assumed.
      // "At risk" is unusable as a marker here — it is also the popover header's
      // worst-state word, at index 0. "Critical path" is the drill group that
      // actually follows.
      const text = dialog.textContent ?? '';
      expect(text.indexOf('Added time')).toBeGreaterThan(text.indexOf('Forecast P80'));
      expect(text.indexOf('Added time')).toBeLessThan(text.indexOf('Critical path'));
    });

    it('carries no band and no proportion track (A3)', async () => {
      const user = userEvent.setup();
      renderAt(`${P}/board`);
      const dialog = await openPopover(user);
      expect(dialog).not.toHaveTextContent('% of remaining duration');
    });
  });

  describe('the value reaches assistive tech at every width', () => {
    it('names the added time in the chip label, with the sign spoken as a word', () => {
      renderAt(`${P}/board`);
      expect(screen.getByTestId('health-cluster')).toHaveAccessibleName(
        /11 days added versus the computed finish/,
      );
    });

    it('says "needs estimates" in the label for an unmeasurable project', () => {
      riskPremium.current = ADDED_TIME_FIXTURES.unmeasurable;
      renderAt(`${P}/board`);
      expect(screen.getByTestId('health-cluster')).toHaveAccessibleName(
        /added time needs estimates/,
      );
    });

    it('adds no added-time clause on Overview, where the card carries it', () => {
      renderAt(`${P}/overview`);
      expect(screen.getByTestId('health-cluster')).not.toHaveAccessibleName(/added time/i);
    });
  });

  describe('a forecast that has not resolved must not assert "Not run yet"', () => {
    it('suppresses the row entirely while the query is in flight', async () => {
      mcLoading.current = true;
      const user = userEvent.setup();
      renderAt(`${P}/board`);
      const dialog = await openPopover(user);
      expect(within(dialog).queryByText('Added time')).not.toBeInTheDocument();
    });

    it('suppresses the row when the forecast read failed', async () => {
      mcErrored.current = true;
      const user = userEvent.setup();
      renderAt(`${P}/board`);
      const dialog = await openPopover(user);
      expect(within(dialog).queryByText('Added time')).not.toBeInTheDocument();
    });
  });
});
