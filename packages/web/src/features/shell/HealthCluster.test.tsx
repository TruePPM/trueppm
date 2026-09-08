import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter, renderWithProvidersAndRouter } from '@/test/utils';
import { FIXTURE_SHELL_STATS } from '@/fixtures/shellStats';
import type { ShellStats, ApiSprint, Methodology, AddedTimeFacts } from '@/types';
import { ADDED_TIME_FIXTURES } from '@/fixtures/addedTime';
import type { ProjectVelocity } from '@/hooks/useSprints';
import type { HealthBand } from '@/lib/healthBand';
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
// The HTTP status `GET /projects/{id}/` failed with, or `null` for a healthy read.
// 404/403 is the "you cannot open this project" shape `useProjectUnavailable`
// keys on (#3469); anything else must NOT suppress the cluster.
const projectErrorStatus = vi.hoisted<{ current: number | null }>(() => ({ current: null }));
vi.mock('@/hooks/useProject', () => ({
  useProject: () => ({
    data: projectLoaded.current ? { id: 'p', methodology: methodology.current } : undefined,
    isLoading: false,
    error:
      projectErrorStatus.current === null
        ? null
        : { isAxiosError: true, response: { status: projectErrorStatus.current } },
  }),
}));

const stats = vi.hoisted<{ current: ShellStats | undefined }>(() => ({ current: undefined }));
// The three non-settled query states, configurable per test. Before #3525 this
// mock pinned `isLoading: false, error: null`, so `stats.current = undefined`
// modelled ONLY the pre-load tick — and every assertion written against it was
// silently exercising the loaded path's fallback. A failed fetch reaches
// `HealthCluster` through the same `data: undefined`, which is the whole bug, so
// a mock that cannot express it cannot test the fix.
const statsLoading = vi.hoisted<{ current: boolean }>(() => ({ current: false }));
const statsErrored = vi.hoisted<{ current: boolean }>(() => ({ current: false }));
const statsRefetch = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useShellStats', () => ({
  useShellStats: () => ({
    data: stats.current,
    isLoading: statsLoading.current,
    error: statsErrored.current ? new Error('status-summary failed') : null,
    refetch: statsRefetch,
  }),
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
  projectErrorStatus.current = null;
  methodology.current = 'WATERFALL';
  stats.current = FIXTURE_SHELL_STATS;
  statsLoading.current = false;
  statsErrored.current = false;
  statsRefetch.mockClear();
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

  // The chip prints the SERVER band word and nothing else (#3470). The expected
  // word is written out as a LITERAL rather than read from `HEALTH_BAND_LABEL`:
  // asserting `HEALTH_BAND_LABEL[band]` against a component that renders
  // `HEALTH_BAND_LABEL[stats.healthBand]` puts the same constant on both sides,
  // so editing a value in that map could not fail it.
  //
  // The band comes off `status-summary`'s `health_band` (#3501). Every case here
  // therefore sets `healthBand` and leaves the counts at the fixture's values,
  // which do NOT agree with it — that is deliberate: if the component ever went
  // back to deriving a band from `criticalCount` / `atRiskCount` these cases
  // would read the fixture's counts (critical 1 → "Critical") and two of the
  // three would fail.
  it.each<[HealthBand, string]>([
    ['on_track', 'On track'],
    ['at_risk', 'At risk'],
    ['critical', 'Critical'],
  ])('the server band %s makes the chip read "%s"', (healthBand, word) => {
    stats.current = { ...FIXTURE_SHELL_STATS, healthBand };
    render();
    expect(screen.getByTestId('health-cluster')).toHaveTextContent(word);
  });

  // (a2) the manual override the counts cannot see -----------------------------

  it("reads the server band over a clean plan — the PM's manual Critical wins", () => {
    // #3501. `Project.health = CRITICAL` on a plan with zero at-risk and zero
    // critical tasks. The server folds the override into `health_band`; the chip
    // prints it. Before the fix the chip could only see the two zero counts, so
    // it said "On track" while the project's own Overview said Critical.
    stats.current = {
      ...FIXTURE_SHELL_STATS,
      healthBand: 'critical',
      atRiskCount: 0,
      criticalCount: 0,
    };
    render();
    const chip = screen.getByTestId('health-cluster');
    expect(chip).toHaveTextContent('Critical');
    expect(chip).not.toHaveTextContent('On track');
    expect(chip).toHaveAttribute('aria-label', expect.stringContaining('Project health: Critical'));
  });

  it('reads the server band over a real critical task — a manual On track wins', () => {
    // The inverse of the case above, and the one a counts-first chip gets wrong
    // in the other direction: a PM has reported ON_TRACK on a project that does
    // have a critical task, so the server band is `on_track` while
    // `criticalCount` is 2.
    stats.current = {
      ...FIXTURE_SHELL_STATS,
      healthBand: 'on_track',
      atRiskCount: 4,
      criticalCount: 2,
    };
    render();
    const chip = screen.getByTestId('health-cluster');
    expect(chip).toHaveTextContent('On track');
    expect(chip).not.toHaveTextContent('Critical');
  });

  it('renders NO band while the summary is in flight — never the reassuring one', () => {
    // Inverted at #3525. This case used to assert "On track" for an unresolved
    // summary and record the failed-fetch collision as a known gap in its own
    // comment. That comment was the bug: `useShellStats` returns
    // `data: undefined` for BOTH states, so the fallback it documented was not
    // covering a pre-load tick — it printed the most reassuring word in the
    // vocabulary over a project whose health nobody could read.
    stats.current = undefined;
    statsLoading.current = true;
    render();
    expect(screen.queryByTestId('health-cluster')).not.toBeInTheDocument();
    const skeleton = screen.getByTestId('health-cluster-loading');
    expect(skeleton).toBeInTheDocument();
    // "On track" IS in this subtree — it is the width shim that keeps the
    // skeleton exactly as wide as the widest real chip. Nobody reads it: it
    // carries Tailwind's `invisible` (`visibility: hidden`, so it paints nothing
    // while still taking its space) and the whole skeleton is `aria-hidden`, so
    // it reaches neither a sighted reader nor assistive tech.
    //
    // Asserted on the class and the attribute rather than with `toBeVisible()`:
    // no Tailwind stylesheet is loaded in jsdom, so `visibility: hidden` is never
    // actually computed and `toBeVisible()` returns true for it — a vacuous pass
    // in the other direction.
    expect(screen.getByText('On track')).toHaveClass('invisible');
    expect(skeleton).toHaveAttribute('aria-hidden', 'true');
  });

  it('chip never renders the retired "On watch" word for the at-risk band', () => {
    // The negative control for the #3470 regression: before the fix the at-risk
    // band printed "On watch", a word defined by no ADR and rendered nowhere
    // else in the product. Asserting the positive word alone does not catch a
    // reintroduction, because "On watch" would still be *a* word for the band.
    stats.current = { ...FIXTURE_SHELL_STATS, healthBand: 'at_risk' };
    render();
    expect(screen.getByTestId('health-cluster')).not.toHaveTextContent('On watch');
  });

  it('critical band reads "Critical", not the at-risk band word', () => {
    // The other half of #3470: the critical band used to print "At risk", so the
    // top bar contradicted the page beneath it. The absence assertion is scoped
    // to the chip trigger — the popover is portaled out of it and repeats the
    // same word from the same source.
    stats.current = { ...FIXTURE_SHELL_STATS, healthBand: 'critical' };
    render();
    const chip = screen.getByTestId('health-cluster');
    expect(chip).toHaveTextContent('Critical');
    expect(chip).not.toHaveTextContent('At risk');
  });

  it('the chip aria-label carries the band word', () => {
    stats.current = { ...FIXTURE_SHELL_STATS, atRiskCount: 0, criticalCount: 1 };
    render();
    expect(screen.getByTestId('health-cluster')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Project health: Critical'),
    );
  });

  it('AGILE project with a critical task still reads "Critical" on the chip', () => {
    // The AGILE cluster has no critical segment, but the chip word derives from
    // the project-wide count on useShellStats — so a real critical task surfaces.
    methodology.current = 'AGILE';
    stats.current = { ...FIXTURE_SHELL_STATS, atRiskCount: 0, criticalCount: 2 };
    render();
    expect(screen.getByTestId('health-cluster')).toHaveTextContent('Critical');
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

  it('a failed summary shows no band and no 0-task drills — the rows would say nothing is wrong', async () => {
    // Inverted at #3525. This used to assert "On track" plus two calm "0 tasks"
    // rows for absent stats, which is the defect twice over: the word was the
    // reassuring one, and the rows beneath it asserted a clean plan for a project
    // whose task counts had not been read at all.
    const user = userEvent.setup();
    stats.current = undefined;
    statsErrored.current = true;
    methodology.current = 'WATERFALL';
    render();

    expect(screen.getByTestId('health-cluster')).not.toHaveTextContent('On track');

    const dialog = await openPopover(user);
    expect(within(dialog).queryByText('0 tasks')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('At risk')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Critical path')).not.toBeInTheDocument();
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

    it('drops the inline fragment on Schedule, where the forecast bar prints the delta', async () => {
      // Rule 291. `ScheduleForecastBar` renders `P80: Nov 4 (+11d)` from the same
      // `delta_vs_cpm` the premium derives from, so an inline `Added +11d` beside it
      // would be one number twice on one screen. The popover row stays — it is behind
      // a click, and it carries states the bar cannot express.
      const user = userEvent.setup();
      renderAt(`${P}/schedule`);

      expect(screen.getByTestId('health-cluster')).not.toHaveTextContent('Added');
      const dialog = await openPopover(user);
      expect(within(dialog).getByText('Added time')).toBeInTheDocument();
    });

    it('still names the added time in the chip label on Schedule', () => {
      // The fragment is dropped for redundancy on screen; the accessible name is the
      // only path a screen-reader user has to the chip's own read, so it stays.
      renderAt(`${P}/schedule`);
      expect(screen.getByTestId('health-cluster')).toHaveAccessibleName(
        /11 days added versus the computed finish/,
      );
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

/**
 * Unavailable-project suppression (#3469).
 *
 * The cluster is mounted by `TopBar`, ABOVE the `<Outlet />` that `ProjectShell`
 * renders `ProjectNotFound` into — so on a project the caller cannot open it kept
 * rendering. Every one of its inputs degrades to a plausible literal rather than to
 * nothing (`stats` absent ⇒ `deriveChipState(0, 0)` ⇒ a confident "On track"), which
 * is why the fix is suppression at the source and not a repair downstream.
 */
describe('HealthCluster — project unavailable', () => {
  it.each([404, 403])('renders nothing when the project query fails with %i', (status) => {
    projectErrorStatus.current = status;
    // The state that made this visible: no stats, so the chip would otherwise
    // assert "On track" for a project that is not there.
    stats.current = undefined;
    projectLoaded.current = false;
    render();
    expect(screen.queryByTestId('health-cluster')).not.toBeInTheDocument();
  });

  it('still renders when the project query fails with a non-access status', () => {
    // A 500 is a transient server fault, not "this project is not yours" — the
    // route keeps rendering the project, so the chrome must too.
    projectErrorStatus.current = 500;
    render();
    expect(screen.getByTestId('health-cluster')).toBeInTheDocument();
  });

  it('renders normally when the project query succeeds', () => {
    render();
    expect(screen.getByTestId('health-cluster')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// #3525 — half 1: the popover must explain the word it prints.
//
// Since #3501 the chip prints the SERVER's band, which folds in the PM's manual
// report, while the popover rows still come from the at-risk / critical counts.
// So the header could assert `Critical` above `At risk 0 tasks / Critical path
// 0 tasks` and nothing said which of the two the reader was looking at.
//
// Every case here drives `healthBandSource` — the server's own answer — and
// never a comparison of band against counts. That distinction is load-bearing
// rather than stylistic: a PM reporting `at_risk` over a plan the counts also
// call at-risk produces exactly the band the counts would, so a comparison
// misses the report on precisely the projects where nothing looks wrong. The
// `…even when the band agrees with the counts` case below is the one that fails
// against a comparison-based implementation and passes against this one.
// ---------------------------------------------------------------------------

describe('HealthCluster provenance (#3525)', () => {
  const REPORTED_ROW = 'health-provenance-row';

  it('names the report as the source when the server says the band was reported', async () => {
    const user = userEvent.setup();
    // The headline scenario: reported Critical over a plan with nothing wrong.
    stats.current = {
      ...FIXTURE_SHELL_STATS,
      healthBand: 'critical',
      healthBandSource: 'reported',
      atRiskCount: 0,
      criticalCount: 0,
      atRiskTasks: [],
      criticalTasks: [],
    };
    render();
    const dialog = await openPopover(user);

    // The header still prints the SERVER's word — the fix explains it, it does
    // not soften or re-derive it (#3501 must not regress).
    expect(within(dialog).getByText('Critical')).toBeInTheDocument();
    const row = within(dialog).getByTestId(REPORTED_ROW);
    expect(row).toHaveTextContent('Reported by the project manager');
    // …and the rows that do NOT explain it are still there, saying zero.
    expect(within(dialog).getAllByText('0 tasks')).toHaveLength(2);
  });

  it('routes to the project Overview, where the report lives, and closes the popover', async () => {
    const user = userEvent.setup();
    stats.current = { ...FIXTURE_SHELL_STATS, healthBandSource: 'reported' };
    render();
    const dialog = await openPopover(user);

    await user.click(within(dialog).getByTestId(REPORTED_ROW));

    // Rule 403(b): on Schedule and Board the top bar is the only health reading
    // there is, so a status the reader cannot resolve from where it is shown is
    // a dead-end indicator.
    expect(mockNavigate).toHaveBeenCalledWith('/projects/test-project-id/overview');
    expect(screen.queryByRole('dialog', { name: 'Project health' })).not.toBeInTheDocument();
  });

  it('renders NOTHING when the band was derived from the counts', async () => {
    const user = userEvent.setup();
    stats.current = { ...FIXTURE_SHELL_STATS, healthBandSource: 'derived' };
    render();
    const dialog = await openPopover(user);

    // On the derived path the drill-through still explains the word, which is
    // the guarantee rule 403 exists to announce the LOSS of. A row asserting it
    // on the common path would be noise on every project in the product.
    expect(within(dialog).queryByTestId(REPORTED_ROW)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/reported by the project manager/i)).not.toBeInTheDocument();
  });

  it('names the report even when the band AGREES with the counts', async () => {
    // The case a client-side comparison cannot see, and the reason the source is
    // a server field. Reported Critical on a plan the counts ALSO call critical:
    // band and rows agree, so a "does the header disagree with its rows?" check
    // concludes derived and never names the person who filed it.
    const user = userEvent.setup();
    stats.current = {
      ...FIXTURE_SHELL_STATS,
      healthBand: 'critical',
      healthBandSource: 'reported',
      criticalCount: 3,
    };
    render();
    const dialog = await openPopover(user);

    expect(within(dialog).getByTestId(REPORTED_ROW)).toBeInTheDocument();
  });

  it('gives an AGILE project a drill-through for a reported band', async () => {
    // The worst case in #3525. `healthClusterModel` emits sprint / points /
    // velocity for AGILE and NO at-risk or critical segment at all, so a Critical
    // chip there had no drill-through of any kind. The row is rendered above
    // `segments.map` and unconditional on methodology precisely so this works —
    // a provenance segment threaded through the model would be absent here.
    const user = userEvent.setup();
    methodology.current = 'AGILE';
    stats.current = {
      ...FIXTURE_SHELL_STATS,
      healthBand: 'critical',
      healthBandSource: 'reported',
    };
    render();
    const dialog = await openPopover(user);

    expect(within(dialog).getByText('Critical')).toBeInTheDocument();
    expect(within(dialog).getByTestId(REPORTED_ROW)).toBeInTheDocument();
    // Confirm this really is the AGILE cluster, or the case proves nothing.
    expect(within(dialog).queryByText('At risk')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Velocity')).toBeInTheDocument();
  });

  it.each<['AGILE' | 'WATERFALL' | 'HYBRID']>([['AGILE'], ['WATERFALL'], ['HYBRID']])(
    'renders the provenance row on %s',
    async (m) => {
      const user = userEvent.setup();
      methodology.current = m;
      stats.current = { ...FIXTURE_SHELL_STATS, healthBandSource: 'reported' };
      render();
      const dialog = await openPopover(user);
      expect(within(dialog).getByTestId(REPORTED_ROW)).toBeInTheDocument();
    },
  );

  it('carries the source in the chip aria-label, which is its ONLY accessible text', () => {
    // The chip is a button with an aria-label, so its inner text is suppressed
    // for assistive tech. A screen-reader user on Board or Schedule cannot reach
    // the popover row without first being told there is something to reach for.
    stats.current = {
      ...FIXTURE_SHELL_STATS,
      healthBand: 'critical',
      healthBandSource: 'reported',
    };
    render();
    expect(screen.getByTestId('health-cluster')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Project health: Critical, reported by the project manager'),
    );
  });

  it('omits the source clause from the aria-label on a derived band', () => {
    stats.current = { ...FIXTURE_SHELL_STATS, healthBandSource: 'derived' };
    const { container } = render();
    expect(
      container.querySelector('[data-testid="health-cluster"]')?.getAttribute('aria-label'),
    ).not.toContain('reported by the project manager');
  });

  it('the provenance row takes neutral ink, never the band color', async () => {
    // ADR-0126's one status vocabulary: semantic hue belongs to the state, not to
    // metadata about the state. A red note under a red header reads as a second,
    // independent health signal and the popover would carry two red things
    // saying one thing.
    const user = userEvent.setup();
    stats.current = {
      ...FIXTURE_SHELL_STATS,
      healthBand: 'critical',
      healthBandSource: 'reported',
    };
    render();
    const dialog = await openPopover(user);
    const row = within(dialog).getByTestId(REPORTED_ROW);

    expect(row.className).not.toContain('text-semantic-critical');
    expect(row.innerHTML).not.toContain('text-semantic-critical');
    expect(row.innerHTML).not.toContain('text-semantic-at-risk');
  });
});

// ---------------------------------------------------------------------------
// #3525 — half 2: an absent band must not render as the reassuring one.
//
// `useShellStats` returns `data: undefined` for an in-flight query AND for a
// failed one, and this component read neither flag — so `?? 'on_track'` painted
// a calm "On track" with an on-track dot over a project that might be Critical,
// indefinitely, on the routes where the top bar is the only health reading.
// ---------------------------------------------------------------------------

describe('HealthCluster absent band (#3525)', () => {
  it('a failed status-summary does NOT render "On track"', () => {
    // The acceptance criterion, stated as bluntly as the issue states it.
    stats.current = undefined;
    statsErrored.current = true;
    render();

    const chip = screen.getByTestId('health-cluster');
    expect(chip).not.toHaveTextContent('On track');
    expect(chip).toHaveTextContent('Health');
    expect(chip).toHaveAttribute('data-state', 'unavailable');
  });

  it('never falls back to a band word at all — not the cautious one either', () => {
    stats.current = undefined;
    statsErrored.current = true;
    render();
    const chip = screen.getByTestId('health-cluster');
    // `at_risk` was the issue's own suggested fallback. It is still a band the
    // client does not have: there is no value here to be cautious *about*, and
    // printing one is the client-side derivation #3501 deleted, under a new name.
    for (const word of ['On track', 'At risk', 'Critical']) {
      expect(chip).not.toHaveTextContent(word);
    }
  });

  it('shows no semantic health dot when there is no band', () => {
    stats.current = undefined;
    statsErrored.current = true;
    const { container } = render();
    const chip = container.querySelector('[data-testid="health-cluster"]');
    // A hollow ring, not a filled dot — no hue at all, so it cannot be read as
    // green/amber/red under any color-vision profile.
    expect(chip?.innerHTML).not.toContain('bg-semantic-on-track');
    expect(chip?.innerHTML).not.toContain('bg-semantic-at-risk');
    expect(chip?.innerHTML).not.toContain('bg-semantic-critical');
  });

  it('rewrites the chip aria-label, which would otherwise announce a word it no longer prints', () => {
    stats.current = undefined;
    statsErrored.current = true;
    render();
    const label = screen.getByTestId('health-cluster').getAttribute('aria-label') ?? '';
    expect(label).toContain('Project health unavailable');
    expect(label).not.toContain('Project health: On track');
  });

  it('opens a popover carrying the failure and a retry, not a health reading', async () => {
    const user = userEvent.setup();
    stats.current = undefined;
    statsErrored.current = true;
    render();

    // The chip stays a real trigger in this state — unlike the loading skeleton,
    // there IS something to explain, and a chip that simply vanished would read
    // as "this project has no health" and reflow the fixed-width right cluster.
    const dialog = await openPopover(user);
    expect(within(dialog).getByTestId('health-error')).toBeInTheDocument();
    expect(within(dialog).getByText("Couldn't load project health.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(statsRefetch).toHaveBeenCalled();
  });

  it('binds the dialog aria-describedby to the failure text', async () => {
    // Rule 335(a): the message is then read WITH the dialog focus is moved into,
    // which works whether or not the live region fires.
    const user = userEvent.setup();
    stats.current = undefined;
    statsErrored.current = true;
    render();
    const dialog = await openPopover(user);
    expect(dialog).toHaveAttribute('aria-describedby', 'health-error-msg');
  });

  it('drops the methodology rows entirely rather than showing confident zeros', async () => {
    const user = userEvent.setup();
    stats.current = undefined;
    statsErrored.current = true;
    methodology.current = 'WATERFALL';
    render();
    const dialog = await openPopover(user);

    // `healthClusterModel` degrades an undefined `stats` to `At risk 0 tasks` /
    // `Critical path 0 tasks` / `Forecast P80 —`. Rendering those under a chip
    // that just said it could not read the health is the same failure-as-good-
    // news defect one level down.
    expect(within(dialog).queryByText('0 tasks')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('At risk')).not.toBeInTheDocument();
  });

  it('treats a 200 that carried no band as unavailable, not as on track', () => {
    // Reached by a different door — an older server, a proxy, or a test mock
    // serving the wrong shape — but the failure direction is identical, so it
    // takes the same branch rather than falling through to a word.
    stats.current = { ...FIXTURE_SHELL_STATS, healthBand: undefined as never };
    render();
    expect(screen.getByTestId('health-cluster')).not.toHaveTextContent('On track');
    expect(screen.getByTestId('health-cluster')).toHaveAttribute('data-state', 'unavailable');
  });

  it('distinguishes in-flight from failed: a skeleton, and it is not the chip', () => {
    statsLoading.current = true;
    stats.current = undefined;
    render();

    // The skeleton must NOT answer to `health-cluster`: two dozen specs locate
    // the surface by that id and one measures its boundingBox for a phone-clip
    // guard, which would then report a clip-safe width for a chip that never
    // rendered.
    expect(screen.queryByTestId('health-cluster')).not.toBeInTheDocument();
    const skeleton = screen.getByTestId('health-cluster-loading');
    expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    // Decoration, not a control: a disabled button would still announce
    // "Project health, button, dimmed" and offer an affordance that does not exist.
    expect(skeleton.tagName).not.toBe('BUTTON');
  });

  it('the skeleton renders the widest band word as its width shim', () => {
    // Width is derived, not pinned: "On track" (48.73px) is the widest of the
    // three, NOT the worst severity. Named for what it proves and no more — jsdom
    // has no layout, so this asserts the MECHANISM (the widest label is the shim)
    // and cannot assert any geometry. The real clip guard is
    // `e2e/mobile-chrome-clip.spec.ts`, which measures in a browser.
    statsLoading.current = true;
    stats.current = undefined;
    render();
    expect(screen.getByTestId('health-cluster-loading')).toHaveTextContent('On track');
  });

  it('suppression still outranks both states on a project the caller cannot open', () => {
    // A 404/403 on the project itself renders nothing at all — the route is about
    // to say "This project isn't available", and a "couldn't load" chip over that
    // would be a second, wrong explanation (#3469 must not regress).
    projectErrorStatus.current = 404;
    statsErrored.current = true;
    render();
    expect(screen.queryByTestId('health-cluster')).not.toBeInTheDocument();
    expect(screen.queryByTestId('health-cluster-loading')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// #3525 — WCAG 2.1 AA 4.1.3. The chip's word can now change because a person
// changed their mind, with no focus move and no navigation event to carry it.
// ---------------------------------------------------------------------------

describe('HealthCluster band announcer (#3525)', () => {
  function announcer() {
    return screen.getByTestId('health-announcer');
  }

  // `renderWithRouter` bakes the element into `createMemoryRouter`'s config, so
  // its `rerender` does not re-render the component under test — the announcer is
  // about a value CHANGING, so these cases need a wrapper that re-renders.
  function renderRerenderable() {
    return renderWithProvidersAndRouter(<HealthCluster onTaskNavigate={vi.fn()} />, {
      initialEntries: ['/projects/test-project-id/board'],
    });
  }

  it('is mounted in every state, with only its text swapped', () => {
    // Rule 335: a `role="status"` node that mounts together with its own content
    // is announced inconsistently across AT, so the region must already be in the
    // tree before there is anything to say.
    statsLoading.current = true;
    stats.current = undefined;
    const loading = render();
    expect(loading.getByTestId('health-announcer')).toHaveAttribute('aria-live', 'polite');
    loading.unmount();

    statsLoading.current = false;
    statsErrored.current = true;
    const errored = render();
    expect(errored.getByTestId('health-announcer')).toBeInTheDocument();
    errored.unmount();

    statsErrored.current = false;
    stats.current = FIXTURE_SHELL_STATS;
    render();
    expect(announcer()).toBeInTheDocument();
  });

  it('says nothing on first render', () => {
    // A band is news only when it CHANGES. Announcing the initial value would
    // fire on every project navigation — noise, not a status message.
    stats.current = { ...FIXTURE_SHELL_STATS, healthBand: 'critical' };
    render();
    expect(announcer()).toHaveTextContent('');
  });

  it('announces a change, naming the report when the change came from a person', () => {
    stats.current = { ...FIXTURE_SHELL_STATS, healthBand: 'on_track', healthBandSource: 'derived' };
    const view = renderRerenderable();
    expect(announcer()).toHaveTextContent('');

    // The PM files a Critical report: the word flips with no edit to the plan,
    // which is exactly the change a reader cannot otherwise account for.
    stats.current = {
      ...FIXTURE_SHELL_STATS,
      healthBand: 'critical',
      healthBandSource: 'reported',
    };
    view.rerender(<HealthCluster onTaskNavigate={vi.fn()} />);

    expect(announcer()).toHaveTextContent(
      'Project health changed to Critical, reported by the project manager.',
    );
  });

  it('announces a derived change without the report clause', () => {
    stats.current = { ...FIXTURE_SHELL_STATS, healthBand: 'on_track', healthBandSource: 'derived' };
    const view = renderRerenderable();
    stats.current = { ...FIXTURE_SHELL_STATS, healthBand: 'at_risk', healthBandSource: 'derived' };
    view.rerender(<HealthCluster onTaskNavigate={vi.fn()} />);

    expect(announcer()).toHaveTextContent('Project health changed to At risk.');
    expect(announcer()).not.toHaveTextContent('reported');
  });

  it('says nothing when the BAND is the same but only the source changed', () => {
    stats.current = { ...FIXTURE_SHELL_STATS, healthBand: 'critical', healthBandSource: 'derived' };
    const view = renderRerenderable();
    stats.current = {
      ...FIXTURE_SHELL_STATS,
      healthBand: 'critical',
      healthBandSource: 'reported',
    };
    view.rerender(<HealthCluster onTaskNavigate={vi.fn()} />);
    // The word on screen did not change, so there is no state change to announce.
    expect(announcer()).toHaveTextContent('');
  });

  it('says nothing when the PROJECT changed, only the band the reader arrived at', () => {
    // `HealthCluster` is mounted by the app shell and outlives any one project, so
    // a ref holding only the last band still holds project A's when B's arrives.
    // A direct project→project navigation — the rail switcher, the command
    // palette, My Work's worst-project link, this popover's own cross-team sprint
    // rows — would then announce "Project health changed to Critical, reported by
    // the project manager" about a project the reader has merely opened, falsely
    // attributing a non-event to a named person. Nothing changed; somebody
    // navigated.
    //
    // Starting the ref at null prevents the announcement once per MOUNT, and the
    // mount is exactly what outlives the project. A `staleTime` hit serves the
    // second project synchronously, so there is not even a loading tick to mask
    // it. The memo therefore carries its subject.
    projectId.current = 'project-a';
    stats.current = { ...FIXTURE_SHELL_STATS, healthBand: 'on_track', healthBandSource: 'derived' };
    const view = renderRerenderable();
    expect(announcer()).toHaveTextContent('');

    projectId.current = 'project-b';
    stats.current = {
      ...FIXTURE_SHELL_STATS,
      healthBand: 'critical',
      healthBandSource: 'reported',
    };
    view.rerender(<HealthCluster onTaskNavigate={vi.fn()} />);

    expect(announcer()).toHaveTextContent('');
  });

  it('is silent while the band is unavailable, and silent again when the SAME band returns', () => {
    // The trap this guards: clearing the remembered band on the failure branch
    // would make every recovery from a 5xx announce as a change, because the band
    // coming back is then compared against nothing rather than against the band
    // that was on screen before the failure.
    stats.current = { ...FIXTURE_SHELL_STATS, healthBand: 'at_risk' };
    const view = renderRerenderable();

    stats.current = undefined;
    statsErrored.current = true;
    view.rerender(<HealthCluster onTaskNavigate={vi.fn()} />);
    expect(announcer()).toHaveTextContent('');

    statsErrored.current = false;
    stats.current = { ...FIXTURE_SHELL_STATS, healthBand: 'at_risk' };
    view.rerender(<HealthCluster onTaskNavigate={vi.fn()} />);
    expect(announcer()).toHaveTextContent('');
  });
});
