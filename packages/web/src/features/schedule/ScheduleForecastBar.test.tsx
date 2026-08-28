import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import { ScheduleForecastBar } from './ScheduleForecastBar';

// Mutable hook state, mirrored from the deleted MonteCarloRow test harness.
let mockResult: {
  data: unknown;
  isLoading: boolean;
  error: Error | null;
  refetch?: () => void;
} = {
  data: FIXTURE_MC_RESULT,
  isLoading: false,
  error: null,
};

vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: () => mockResult,
}));

const runMutate = vi.hoisted(() => vi.fn());
let runState: { isPending: boolean; isError: boolean } = { isPending: false, isError: false };

vi.mock('@/hooks/useRunMonteCarlo', () => ({
  useRunMonteCarlo: () => ({
    mutate: runMutate,
    isPending: runState.isPending,
    isError: runState.isError,
  }),
}));

// History section makes its own network call; stub it to render nothing so the
// bar's own surface is the unit under test.
vi.mock('./ForecastHistorySection', () => ({
  ForecastHistorySection: () => null,
}));

beforeEach(() => {
  runMutate.mockReset();
  runState = { isPending: false, isError: false };
  mockResult = { data: FIXTURE_MC_RESULT, isLoading: false, error: null };
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('ScheduleForecastBar', () => {
  it('renders nothing when there is no project context', () => {
    mockResult = { data: undefined, isLoading: false, error: null };
    const { container } = renderWithProviders(
      <ScheduleForecastBar projectId={undefined} tasks={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the single "Run a simulation" prompt when no result is cached', () => {
    mockResult = { data: undefined, isLoading: false, error: null };
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(
      screen.getByText(/Run a simulation to see P50\/P80\/P95/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run Monte Carlo/i })).toBeInTheDocument();
  });

  it('shows a distinct load-failure state (not the never-run prompt) when the fetch errors', async () => {
    // A 404 "never run" is mapped to no-error by the hook; a real error means the
    // existing forecast couldn't load and must not read as "never run" (#1938).
    const refetch = vi.fn();
    mockResult = { data: undefined, isLoading: false, error: new Error('boom'), refetch };
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't load the forecast/i);
    expect(screen.queryByText(/Run a simulation/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run Monte Carlo/i })).not.toBeInTheDocument();
    // Retry re-runs just the query rather than forcing a full recompute.
    await userEvent.click(screen.getByRole('button', { name: /^Retry$/i }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('renders the P50/P80/P95 chips exactly once', () => {
    renderWithProviders(
      <ScheduleForecastBar projectId="p1" tasks={[]} cpmFinish="2026-10-05" />,
    );
    // Each label appears exactly once on the collapsed header (rule 189).
    expect(screen.getAllByText(/^P50:/)).toHaveLength(1);
    expect(screen.getAllByText(/^P80:/)).toHaveLength(1);
    expect(screen.getAllByText(/^P95:/)).toHaveLength(1);
  });

  it('formats the P80 chip date in UTC and shows the server risk delta', () => {
    renderWithProviders(
      <ScheduleForecastBar projectId="p1" tasks={[]} cpmFinish="2026-10-05" />,
    );
    // 2026-11-03 → "Nov 3" in UTC regardless of host timezone; delta 29d.
    expect(screen.getByText(/P80: Nov 3 \(\+29d\)/)).toBeInTheDocument();
  });

  it('reads the CPM baseline from the run payload even without the prop (#2426)', () => {
    // The payload's `cpmFinish` is the server-owned source of truth (#987), so a
    // missing prop is not a reason to drop the delta — and the dashed reference
    // chip means the baseline date is on screen wherever the delta renders.
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(screen.getByText(/P80: Nov 3 \(\+29d\)/)).toBeInTheDocument();
    expect(screen.getByText('CPM: Oct 5')).toBeInTheDocument();
  });

  it('omits the delta entirely when no CPM finish is known anywhere', () => {
    // Never a delta without its baseline: with no spine to measure from, the
    // percentile chips stand alone rather than showing an unanchored number.
    mockResult = {
      data: { ...FIXTURE_MC_RESULT, cpmFinish: null },
      isLoading: false,
      error: null,
    };
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(screen.getByText(/P80: Nov 3$/)).toBeInTheDocument();
    expect(screen.queryByText(/CPM:/)).not.toBeInTheDocument();
  });

  it('collapses a degenerate run to one chip that names its own baseline (#2426)', () => {
    // Three identical percentile chips imply a spread the run does not have.
    mockResult = {
      data: { ...FIXTURE_MC_RESULT, p50: '2026-10-06', p80: '2026-10-06', p95: '2026-10-06' },
      isLoading: false,
      error: null,
    };
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(screen.getByText(/^Forecast: Oct 6 · \+29d vs CPM \(Oct 5\)$/)).toBeInTheDocument();
    expect(screen.queryByText(/P50:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/P80:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/P95:/)).not.toBeInTheDocument();
  });

  it('withholds Rerun on a fresh forecast and offers it once stale (#3132)', () => {
    // UX-REVIEW §8.1: a recompute button parked on every forecast row is a debug
    // affordance on a user surface. Fresh, the bar states when the server last
    // confirmed the run and offers nothing; stale, it says so AND offers the
    // action. Details is the constant — it is what keeps the row height fixed
    // across the transition, so no layout shift is possible from the gate.
    const { rerender } = renderWithProviders(
      <ScheduleForecastBar projectId="p1" tasks={[]} mutationVersion={0} />,
    );
    expect(
      screen.queryByRole('button', { name: /Rerun Monte Carlo forecast/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('mc-recomputing')).not.toBeInTheDocument();
    expect(screen.getByTestId('mc-details-btn')).toBeInTheDocument();

    // A task mutation lands — the same signal ScheduleView feeds the bar.
    rerender(<ScheduleForecastBar projectId="p1" tasks={[]} mutationVersion={1} />);

    expect(screen.getByTestId('mc-recomputing')).toHaveTextContent(
      /Stale — rerun for updated forecast/,
    );
    expect(screen.getByRole('button', { name: /Rerun Monte Carlo forecast/i })).toBeInTheDocument();
    expect(screen.getByTestId('mc-details-btn')).toBeInTheDocument();
  });

  it('fires the rerun mutation from the Rerun button once stale', async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(
      <ScheduleForecastBar projectId="p1" tasks={[]} mutationVersion={0} />,
    );
    rerender(<ScheduleForecastBar projectId="p1" tasks={[]} mutationVersion={1} />);
    await user.click(screen.getByRole('button', { name: /Rerun Monte Carlo forecast/i }));
    expect(runMutate).toHaveBeenCalledTimes(1);
  });

  it('toggles the expanded body and persists the state to localStorage', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    const toggle = screen.getByRole('button', { name: /Maximize forecast detail/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(localStorage.getItem('schedule.insightsExpanded')).toBe('true');
    // The histogram + tornado headings appear once expanded.
    expect(
      screen.getByRole('heading', { name: /Finish-date forecast/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /What's holding the date/i }),
    ).toBeInTheDocument();
  });

  it('restores the expanded state from localStorage on mount', () => {
    localStorage.setItem('schedule.insightsExpanded', 'true');
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(
      screen.getByRole('button', { name: /Minimize forecast detail/i }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the recomputing indicator while a rerun is pending', () => {
    runState = { isPending: true, isError: false };
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(screen.getByTestId('mc-recomputing')).toBeInTheDocument();
    // The button survives its own in-flight run (#3132): the gate is
    // `runMc.isPending || isStale`, so it does not vanish out from under the
    // click that started the run — it goes disabled and says so.
    const rerun = screen.getByRole('button', { name: /Rerun Monte Carlo forecast/i });
    expect(rerun).toBeDisabled();
    expect(rerun).toHaveTextContent('Rerunning…');
  });

  it('opens the detail panel from the Details button', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    await user.click(screen.getByTestId('mc-details-btn'));
    expect(screen.getByTestId('mc-detail-panel')).toBeInTheDocument();
  });
});
