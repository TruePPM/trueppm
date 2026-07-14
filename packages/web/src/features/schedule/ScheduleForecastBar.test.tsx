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

  it('omits the (+Nd) delta when no CPM finish is known', () => {
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(screen.getByText(/P80: Nov 3$/)).toBeInTheDocument();
  });

  it('exposes Rerun and Details as distinct affordances', () => {
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    expect(screen.getByRole('button', { name: /Rerun Monte Carlo forecast/i })).toBeInTheDocument();
    expect(screen.getByTestId('mc-details-btn')).toBeInTheDocument();
  });

  it('fires the rerun mutation from the Rerun button', async () => {
    const user = userEvent.setup();
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
  });

  it('opens the detail panel from the Details button', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScheduleForecastBar projectId="p1" tasks={[]} />);
    await user.click(screen.getByTestId('mc-details-btn'));
    expect(screen.getByTestId('mc-detail-panel')).toBeInTheDocument();
  });
});
