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
  useProject: () => ({ data: { id: 'p', methodology: methodology.current }, isLoading: false, error: null }),
}));

const stats = vi.hoisted<{ current: ShellStats | undefined }>(() => ({ current: undefined }));
vi.mock('@/hooks/useShellStats', () => ({
  useShellStats: () => ({ data: stats.current, isLoading: false, error: null }),
}));

const activeSprint = vi.hoisted<{ current: ApiSprint | null }>(() => ({ current: null }));
const velocity = vi.hoisted<{ current: ProjectVelocity | undefined }>(() => ({ current: undefined }));
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
  mockNavigate.mockClear();
});

function render() {
  return renderWithRouter(<HealthCluster onTaskNavigate={vi.fn()} />, {
    initialEntries: ['/projects/test-project-id/board'],
  });
}

describe('HealthCluster', () => {
  it('renders the bordered cluster group', () => {
    render();
    expect(screen.getByRole('group', { name: 'Project health' })).toBeInTheDocument();
  });

  it('WATERFALL — Forecast (P50·P80 band) + at-risk + critical segments', () => {
    methodology.current = 'WATERFALL';
    render();
    const cluster = screen.getByRole('group', { name: 'Project health' });
    const forecast = within(cluster).getByRole('button', { name: /monte carlo forecast/i });
    // Band drill-through (#1197): both percentiles surface inline, not a binary read.
    expect(forecast).toHaveAccessibleName(/P50 .*P80/i);
    expect(forecast).toHaveTextContent(/P50/);
    expect(forecast).toHaveTextContent(/P80/);
    expect(within(cluster).getByRole('button', { name: /2 at-risk tasks/i })).toBeInTheDocument();
    expect(within(cluster).getByRole('button', { name: /1 critical task$/i })).toBeInTheDocument();
  });

  it('WATERFALL — forecast degrades to P80 alone when no MC distribution is cached', () => {
    methodology.current = 'WATERFALL';
    mcResult.current = undefined;
    render();
    const cluster = screen.getByRole('group', { name: 'Project health' });
    const forecast = within(cluster).getByRole('button', { name: /monte carlo p80 completion/i });
    expect(forecast).toHaveTextContent(/P80/);
    expect(forecast).not.toHaveTextContent(/P50/);
  });

  it('AGILE — Sprint + Points + Velocity segments, no at-risk/critical', () => {
    methodology.current = 'AGILE';
    render();
    const cluster = screen.getByRole('group', { name: 'Project health' });
    expect(within(cluster).getByText('Sprint 7')).toBeInTheDocument();
    expect(within(cluster).getByText(/Day \d+\/\d+/)).toBeInTheDocument();
    expect(within(cluster).getByText('32/40')).toBeInTheDocument();
    const vel = within(cluster).getByRole('button', { name: /velocity 24 points per sprint/i });
    // Trust boundary (#1197 — Morgan): the in-audience figure names its audience scope.
    expect(vel).toHaveAccessibleName(/visible to project members only/i);
    expect(within(cluster).queryByRole('button', { name: /at-risk/i })).not.toBeInTheDocument();
  });

  it('AGILE — velocity is a content-free privacy wall when suppressed (ADR-0104, rule 168)', () => {
    methodology.current = 'AGILE';
    velocity.current = { ...VELOCITY, velocity_suppressed: true };
    render();
    const cluster = screen.getByRole('group', { name: 'Project health' });
    expect(within(cluster).getByText(/kept to the team/i)).toBeInTheDocument();
    // the number is never rendered
    expect(within(cluster).queryByText(/24/)).not.toBeInTheDocument();
    expect(within(cluster).queryByRole('button', { name: /velocity 24/i })).not.toBeInTheDocument();
  });

  it('AGILE — no active sprint shows the empty sprint affordance and omits Points', () => {
    methodology.current = 'AGILE';
    activeSprint.current = null;
    render();
    const cluster = screen.getByRole('group', { name: 'Project health' });
    expect(within(cluster).getByText(/no active sprint/i)).toBeInTheDocument();
    expect(within(cluster).queryByText('32/40')).not.toBeInTheDocument();
  });

  it('HYBRID — Sprint + Forecast + Critical, no at-risk', () => {
    methodology.current = 'HYBRID';
    render();
    const cluster = screen.getByRole('group', { name: 'Project health' });
    expect(within(cluster).getByText('Sprint 7')).toBeInTheDocument();
    expect(within(cluster).getByRole('button', { name: /monte carlo forecast/i })).toBeInTheDocument();
    expect(within(cluster).getByRole('button', { name: /1 critical task$/i })).toBeInTheDocument();
    expect(within(cluster).queryByRole('button', { name: /at-risk/i })).not.toBeInTheDocument();
  });

  it('forecast "—" when the scheduler has not run', () => {
    methodology.current = 'WATERFALL';
    // Genuine empty state: neither the status summary nor a live MC result
    // carries a P80. The summary alone being null is no longer enough — the
    // segment now falls back to the live MC result's p80 (ADR-0144 fix for the
    // "P80 —" bug), so the MC result must be absent for the em-dash to show.
    stats.current = { ...FIXTURE_SHELL_STATS, monteCarlop80: null };
    mcResult.current = undefined;
    render();
    const cluster = screen.getByRole('group', { name: 'Project health' });
    expect(within(cluster).queryByRole('button', { name: /monte carlo/i })).not.toBeInTheDocument();
    expect(within(cluster).getByText('—')).toBeInTheDocument();
  });

  it('forecast falls back to the live MC P80 when the status summary omits it', () => {
    methodology.current = 'WATERFALL';
    // The status summary hardcodes monte_carlo_p80 = null (projects/views.py),
    // but a fresh MC run is cached. The header must show that p80, not "—".
    stats.current = { ...FIXTURE_SHELL_STATS, monteCarlop80: null };
    mcResult.current = { p50: '2026-10-05', p80: '2026-11-03', p95: '2026-11-30' };
    render();
    const cluster = screen.getByRole('group', { name: 'Project health' });
    expect(within(cluster).getByRole('button', { name: /monte carlo/i })).toBeInTheDocument();
    expect(within(cluster).queryByText('—')).not.toBeInTheDocument();
  });

  it('clicking the Forecast segment opens the MC distribution panel', async () => {
    const user = userEvent.setup();
    methodology.current = 'WATERFALL';
    render();
    const cluster = screen.getByRole('group', { name: 'Project health' });
    await user.click(within(cluster).getByRole('button', { name: /monte carlo forecast/i }));
    expect(screen.getByRole('dialog', { name: /monte carlo confidence/i })).toBeInTheDocument();
  });

  it('at-risk segment opens a task popover', async () => {
    const user = userEvent.setup();
    methodology.current = 'WATERFALL';
    render();
    const cluster = screen.getByRole('group', { name: 'Project health' });
    await user.click(within(cluster).getByRole('button', { name: /2 at-risk tasks/i }));
    expect(screen.getByRole('menuitem', { name: /frontend build/i })).toBeInTheDocument();
  });

  it('Sprint segment navigates to the sprints view', async () => {
    const user = userEvent.setup();
    methodology.current = 'AGILE';
    render();
    const cluster = screen.getByRole('group', { name: 'Project health' });
    await user.click(within(cluster).getByRole('button', { name: /sprint 7, day \d+ of \d+/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/projects/test-project-id/sprints');
  });

  it('renders the < lg collapsed Health dropdown', () => {
    render();
    expect(screen.getByRole('button', { name: /project health summary/i })).toBeInTheDocument();
  });

  it('is suppressed on a project settings route (rule 123 / ADR-0128 §C)', () => {
    const { container } = renderWithRouter(<HealthCluster onTaskNavigate={vi.fn()} />, {
      initialEntries: ['/projects/test-project-id/settings/general'],
    });
    expect(container.firstChild).toBeNull();
  });
});
