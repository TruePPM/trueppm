import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import { ScheduleForecastBar } from './ScheduleForecastBar';
import { axiosRefusal } from '@/test/axiosError';

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
let runState: { isPending: boolean; isError: boolean; error: unknown } = {
  isPending: false,
  isError: false,
  error: null,
};

vi.mock('@/hooks/useRunMonteCarlo', () => ({
  useRunMonteCarlo: () => ({
    mutate: runMutate,
    isPending: runState.isPending,
    isError: runState.isError,
    error: runState.error,
  }),
}));

// History section makes its own network call; stub it to render nothing so the
// bar's own surface is the unit under test.
vi.mock('./ForecastHistorySection', () => ({
  ForecastHistorySection: () => null,
}));

beforeEach(() => {
  runMutate.mockReset();
  runState = { isPending: false, isError: false, error: null };
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
    expect(screen.getByText(/Run a simulation to see P50\/P80\/P95/i)).toBeInTheDocument();
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
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} cpmFinish="2026-10-05" />);
    // Each label appears exactly once on the collapsed header (rule 189).
    expect(screen.getAllByText(/^P50:/)).toHaveLength(1);
    expect(screen.getAllByText(/^P80:/)).toHaveLength(1);
    expect(screen.getAllByText(/^P95:/)).toHaveLength(1);
  });

  it('formats the P80 chip date in UTC and shows the server risk delta', () => {
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} cpmFinish="2026-10-05" />);
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

  it('withholds Rerun only when the SERVER says the forecast is current (#3132, #3140)', () => {
    // UX-REVIEW §8.1: a recompute button parked on every forecast row is a debug
    // affordance on a user surface. But the gate is only defensible if the
    // predicate is true of the data rather than of this component instance —
    // #3140. `current` is the one value that withholds the action, and it comes
    // off the payload, so it survives a remount (asserted below).
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(
      screen.queryByRole('button', { name: /Rerun Monte Carlo forecast/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('mc-recomputing')).not.toBeInTheDocument();
    expect(screen.getByTestId('mc-details-btn')).toBeInTheDocument();
  });

  it('offers Rerun and says the run is stale when the server reports `aged`', () => {
    mockResult = {
      data: { ...FIXTURE_MC_RESULT, forecastStaleness: 'aged' },
      isLoading: false,
      error: null,
    };
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(screen.getByTestId('mc-recomputing')).toHaveTextContent(
      /Stale — rerun for updated forecast/,
    );
    expect(screen.getByRole('button', { name: /Rerun Monte Carlo forecast/i })).toBeInTheDocument();
    expect(screen.getByTestId('mc-details-btn')).toBeInTheDocument();
  });

  it('says only "edited since this run" for `projectChanged` — never that the plan changed', () => {
    // The server-side counter advances on ANY write in the project (a logged time
    // entry, a label), so the notice must not assert that a date moved. This test
    // is the guard on that wording, not on the presence of a notice.
    mockResult = {
      data: { ...FIXTURE_MC_RESULT, forecastStaleness: 'projectChanged' },
      isLoading: false,
      error: null,
    };
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(screen.getByTestId('mc-recomputing')).toHaveTextContent(/Edited since this run/);
    expect(screen.getByTestId('mc-recomputing')).not.toHaveTextContent(/plan changed/i);
    expect(screen.getByRole('button', { name: /Rerun Monte Carlo forecast/i })).toBeInTheDocument();
  });

  it('offers Rerun but makes NO staleness claim when the server reports `unknown`', () => {
    // A run recorded before #3140 carries no plan version, so the server cannot
    // place it. The action stays reachable (that is the defect being fixed) while
    // the bar keeps the ordinary `N ago` stamp — an unfounded "Stale" would be the
    // same defect with the sign flipped.
    mockResult = {
      data: { ...FIXTURE_MC_RESULT, forecastStaleness: 'unknown' },
      isLoading: false,
      error: null,
    };
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(screen.getByRole('button', { name: /Rerun Monte Carlo forecast/i })).toBeInTheDocument();
    expect(screen.queryByTestId('mc-recomputing')).not.toBeInTheDocument();
  });

  it('keeps the Rerun button across a full remount — the predicate is not session state', () => {
    // The falsification line from #3140, as a unit test: the old predicate was a
    // `useState(0)` counter, so a remount (the component's stand-in for a reload or
    // a route re-entry) reset it to 0 and the button vanished. Reverting the fix
    // makes THIS assertion fail, which is the only one that pins the actual defect.
    mockResult = {
      data: { ...FIXTURE_MC_RESULT, forecastStaleness: 'projectChanged' },
      isLoading: false,
      error: null,
    };
    const { unmount } = renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(screen.getByRole('button', { name: /Rerun Monte Carlo forecast/i })).toBeInTheDocument();
    unmount();

    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(screen.getByRole('button', { name: /Rerun Monte Carlo forecast/i })).toBeInTheDocument();
  });

  it('fires the rerun mutation from the Rerun button once stale', async () => {
    const user = userEvent.setup();
    mockResult = {
      data: { ...FIXTURE_MC_RESULT, forecastStaleness: 'projectChanged' },
      isLoading: false,
      error: null,
    };
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
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
    expect(screen.getByRole('heading', { name: /Finish-date forecast/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /What's holding the date/i })).toBeInTheDocument();
  });

  it('caps its own height and makes the expanded body the scroller (#3166)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    const bar = screen.getByRole('region', { name: 'Schedule forecast' });

    // The bar is a `flex-shrink-0` child of ScheduleView's
    // `flex flex-col h-full overflow-hidden` column. Without a cap its expanded
    // body grows without bound: a twelve-run history measured 1685px inside a
    // 640px column, putting 1114px past an ancestor that cannot scroll and
    // squeezing the Gantt canvas to zero height.
    expect(bar).toHaveClass('max-h-[40vh]');
    expect(bar).toHaveClass('md:flex');
    expect(bar).toHaveClass('md:flex-col');

    await user.click(screen.getByRole('button', { name: /Maximize forecast detail/i }));
    const body = document.getElementById('schedule-forecast-panel');
    expect(body).not.toBeNull();
    expect(body).toHaveClass('overflow-y-auto');
    // `min-h-0` is the load-bearing half: a flex item defaults to
    // `min-height: auto` and refuses to shrink below its content, so without it
    // the scroller never engages and the overflow goes back to the clipping
    // ancestor — the cap alone would just move where the content is lost.
    expect(body).toHaveClass('min-h-0');
    expect(body).toHaveClass('flex-1');

    // jsdom computes no layout, so this pins the MECHANISM only. The measured
    // values — that the bar fits, that the body has somewhere to scroll, and
    // that the canvas is no longer 0px — are asserted in a real engine by
    // `e2e/clipped-content.spec.ts` (web rule 300(b) / 330(c)).
  });

  it('restores the expanded state from localStorage on mount', () => {
    localStorage.setItem('schedule.insightsExpanded', 'true');
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(screen.getByRole('button', { name: /Minimize forecast detail/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('shows the recomputing indicator while a rerun is pending', () => {
    runState = { isPending: true, isError: false, error: null };
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

describe('ScheduleForecastBar — a refused run (#3332)', () => {
  it("shows the SERVER's reason and announces it, instead of a generic sentence", () => {
    // The desktop twin of MobileMonteCarloCard, off the same `useRunMonteCarlo`
    // hook — it read `'Could not run simulation. Try again.'` for every refusal.
    runState = {
      isPending: false,
      isError: true,
      error: axiosRefusal(400, { detail: 'No tasks have three-point estimates yet.' }),
    };
    mockResult = { data: undefined, isLoading: false, error: null };
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('No tasks have three-point estimates yet.');
    expect(alert).not.toHaveTextContent(/try again/i);
    // The verb survives — a 400 is a decision, and the act is still available
    // once the planner estimates something (web-rule 372a).
    expect(screen.getByRole('button', { name: 'Run Monte Carlo' })).toBeInTheDocument();
  });

  it('falls back to a plain sentence when the failure carries no readable body', () => {
    runState = { isPending: false, isError: true, error: new Error('Network Error') };
    mockResult = { data: undefined, isLoading: false, error: null };
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't run the simulation.");
  });
});
