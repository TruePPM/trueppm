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
});
