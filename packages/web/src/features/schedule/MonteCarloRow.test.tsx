import { screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { MonteCarloRow } from './MonteCarloRow';

import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';

// Mutable state used by individual tests to override the hook return.
let mockResult: { data: unknown; isLoading: boolean; error: null } = {
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

beforeEach(() => {
  runMutate.mockReset();
  runState = { isPending: false, isError: false };
});

describe('MonteCarloRow', () => {
  it('renders nothing when projectId is undefined (no project context)', () => {
    mockResult = { data: undefined, isLoading: false, error: null };
    const { container } = renderWithProviders(
      <MonteCarloRow engine={null} taskListWidth={364} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders with null engine (pre-init)', () => {
    mockResult = { data: FIXTURE_MC_RESULT, isLoading: false, error: null };
    // Should render without crashing; bars won't be positioned yet
    renderWithProviders(<MonteCarloRow engine={null} taskListWidth={364} />);
    expect(screen.getByLabelText(/Monte Carlo confidence row/i)).toBeInTheDocument();
  });

  it('renders the label cell', () => {
    renderWithProviders(<MonteCarloRow engine={null} taskListWidth={364} />);
    expect(screen.getByText('Monte Carlo')).toBeInTheDocument();
  });

  it('shows sigma symbol in the label', () => {
    renderWithProviders(<MonteCarloRow engine={null} taskListWidth={364} />);
    expect(screen.getByText('σ')).toBeInTheDocument();
  });

  it('renders the timeline with the plain-English headline as its accessible label', () => {
    // The timeline is no longer a button — explanation is carried by a `title`
    // mirrored to `aria-label` on a static div, so the label-based query is
    // the right way to find it.
    renderWithProviders(<MonteCarloRow engine={null} taskListWidth={364} />);
    expect(
      screen.getByLabelText(/8 in 10 simulations finish by/i),
    ).toBeInTheDocument();
  });

  describe('empty state — no simulation cached', () => {
    it('renders a "Run Monte Carlo" CTA when result is undefined and projectId is set', () => {
      mockResult = { data: undefined, isLoading: false, error: null };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} />,
      );
      expect(
        screen.getByLabelText(/Monte Carlo confidence row — no simulation run yet/i),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Run Monte Carlo/i })).toBeInTheDocument();
      expect(screen.getByText(/Run a simulation to see/i)).toBeInTheDocument();
    });

    it('clicking the CTA fires the run mutation', () => {
      mockResult = { data: undefined, isLoading: false, error: null };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Run Monte Carlo/i }));
      expect(runMutate).toHaveBeenCalledTimes(1);
    });

    it('shows "Running…" and disables the button while the mutation is pending', () => {
      mockResult = { data: undefined, isLoading: false, error: null };
      runState = { isPending: true, isError: false };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} />,
      );
      const btn = screen.getByRole('button', { name: /Running…/ });
      expect(btn).toBeDisabled();
    });

    it('shows the loading copy while the latest-MC query is loading', () => {
      mockResult = { data: undefined, isLoading: true, error: null };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} />,
      );
      expect(screen.getByText(/Loading forecast…/i)).toBeInTheDocument();
    });

    it('shows a retry-friendly message when the run mutation errored', () => {
      mockResult = { data: undefined, isLoading: false, error: null };
      runState = { isPending: false, isError: true };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} />,
      );
      expect(screen.getByText(/Could not run simulation\. Try again\./i)).toBeInTheDocument();
    });
  });

  describe('Details button and panel (#333)', () => {
    it('renders a Details button when a result is cached', () => {
      mockResult = { data: FIXTURE_MC_RESULT, isLoading: false, error: null };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} />,
      );
      expect(
        screen.getByRole('button', { name: /Open Monte Carlo detail panel/i }),
      ).toBeInTheDocument();
    });

    it('clicking Details opens the detail panel dialog', () => {
      mockResult = { data: FIXTURE_MC_RESULT, isLoading: false, error: null };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Open Monte Carlo detail panel/i }));
      expect(screen.getAllByRole('dialog')[0]).toHaveAttribute(
        'aria-label',
        'Monte Carlo forecast detail',
      );
    });
  });

  describe('recomputing state (#333)', () => {
    it('shows recomputing text and data-testid when Rerun is pending', () => {
      mockResult = { data: { ...FIXTURE_MC_RESULT, lastRunAt: '2026-05-05T10:00:00Z' }, isLoading: false, error: null };
      runState = { isPending: true, isError: false };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} />,
      );
      expect(screen.getByTestId('mc-recomputing')).toBeInTheDocument();
      expect(screen.getByTestId('mc-recomputing')).toHaveTextContent('Recomputing…');
    });

    it('does not show recomputing state when idle', () => {
      mockResult = { data: FIXTURE_MC_RESULT, isLoading: false, error: null };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} />,
      );
      expect(screen.queryByTestId('mc-recomputing')).not.toBeInTheDocument();
    });
  });

  describe('P80 delta vs CPM finish (#333)', () => {
    it('shows +Nd delta suffix on P80 chip when cpmFinish is earlier', () => {
      // FIXTURE_MC_RESULT.p80 = '2026-11-03'; CPM finish = '2026-10-05' → +29d
      mockResult = { data: FIXTURE_MC_RESULT, isLoading: false, error: null };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} cpmFinish="2026-10-05" />,
      );
      expect(screen.getByText(/P80:.*\(\+29d\)/)).toBeInTheDocument();
    });

    it('reads the P80 delta from the server deltaVsCpm, not a client subtraction', () => {
      // #987: the chip's delta comes from the server. Override deltaVsCpm.p80 to
      // a value that does NOT equal daysBetween(cpmFinish, p80) to prove it.
      mockResult = {
        data: { ...FIXTURE_MC_RESULT, deltaVsCpm: { p50: 0, p80: 11, p95: 56 } },
        isLoading: false,
        error: null,
      };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} cpmFinish="2026-10-05" />,
      );
      expect(screen.getByText(/P80:.*\(\+11d\)/)).toBeInTheDocument();
    });

    it('omits delta suffix when cpmFinish is not provided', () => {
      mockResult = { data: FIXTURE_MC_RESULT, isLoading: false, error: null };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} />,
      );
      // P80 chip should not contain a delta suffix
      const p80Chip = screen.getByText(/^P80: /);
      expect(p80Chip.textContent).not.toContain('(+');
    });
  });

  describe('populated state — Rerun affordance and freshness signal (issue #335)', () => {
    it('renders a Rerun button alongside the chips when a result is cached', () => {
      // Pre-#335: the run-MC button only appeared in the empty state. Once a
      // result was cached, the row was read-only until the 24h cache expired.
      mockResult = {
        data: { ...FIXTURE_MC_RESULT, lastRunAt: '2026-05-05T10:00:00Z' },
        isLoading: false,
        error: null,
      };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} />,
      );
      expect(
        screen.getByRole('button', { name: /Rerun Monte Carlo forecast/i }),
      ).toBeInTheDocument();
    });

    it('clicking the populated-state Rerun button fires the run mutation', () => {
      mockResult = {
        data: { ...FIXTURE_MC_RESULT, lastRunAt: '2026-05-05T10:00:00Z' },
        isLoading: false,
        error: null,
      };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Rerun Monte Carlo forecast/i }));
      expect(runMutate).toHaveBeenCalledTimes(1);
    });

    it('shows "Rerunning…" and disables the button while the mutation is pending', () => {
      mockResult = {
        data: { ...FIXTURE_MC_RESULT, lastRunAt: '2026-05-05T10:00:00Z' },
        isLoading: false,
        error: null,
      };
      runState = { isPending: true, isError: false };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} />,
      );
      const btn = screen.getByRole('button', { name: /Rerun Monte Carlo forecast/i });
      expect(btn).toBeDisabled();
      expect(btn).toHaveTextContent(/Rerunning…/);
    });

    it('omits the freshness label when lastRunAt is absent (legacy cached payload)', () => {
      // Cached payloads written before #335 will not have lastRunAt. The row
      // must still render and the Rerun button must still be present.
      mockResult = { data: FIXTURE_MC_RESULT, isLoading: false, error: null };
      renderWithProviders(
        <MonteCarloRow engine={null} projectId="proj-1" taskListWidth={364} />,
      );
      expect(
        screen.getByRole('button', { name: /Rerun Monte Carlo forecast/i }),
      ).toBeInTheDocument();
    });
  });
});
