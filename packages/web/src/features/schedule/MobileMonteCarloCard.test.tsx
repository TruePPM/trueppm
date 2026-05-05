import { screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import type { UseMonteCarloResultReturn } from '@/hooks/useMonteCarloResult';
import { MobileMonteCarloCard } from './MobileMonteCarloCard';

const useMonteCarloResultSpy = vi.hoisted(() =>
  vi.fn<(projectId?: string) => UseMonteCarloResultReturn>(),
);

vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: (projectId?: string) => useMonteCarloResultSpy(projectId),
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
  useMonteCarloResultSpy.mockReset();
  useMonteCarloResultSpy.mockReturnValue({
    data: FIXTURE_MC_RESULT,
    isLoading: false,
    error: null,
  });
  runMutate.mockReset();
  runState = { isPending: false, isError: false };
});

describe('MobileMonteCarloCard (#33)', () => {
  it('renders P50/P80/P95 chips with dates', () => {
    renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
    const button = screen.getByRole('button', { name: /Monte Carlo confidence/ });
    expect(button).toHaveTextContent(/P50:/);
    expect(button).toHaveTextContent(/P80:/);
    expect(button).toHaveTextContent(/P95:/);
  });

  it('tap target meets the 44px minimum (rule 5)', () => {
    renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
    const button = screen.getByRole('button', { name: /Monte Carlo confidence/ });
    // `min-h-11` = 44px floor
    expect(button.className).toMatch(/min-h-11/);
  });

  it('is suppressed at md and above (md:hidden class present)', () => {
    renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
    const button = screen.getByRole('button', { name: /Monte Carlo confidence/ });
    expect(button.className).toMatch(/\bmd:hidden\b/);
  });

  it('opens the histogram sheet on tap and closes on Escape', () => {
    renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
    const button = screen.getByRole('button', { name: /Monte Carlo confidence/ });
    fireEvent.click(button);

    const dialog = screen.getByRole('dialog', {
      name: /Monte Carlo confidence distribution/i,
    });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    // 44×44 close target
    const close = screen.getByRole('button', { name: /Close Monte Carlo detail/i });
    expect(close.className).toMatch(/w-11/);
    expect(close.className).toMatch(/h-11/);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: /Monte Carlo confidence distribution/i }),
    ).not.toBeInTheDocument();
  });

  it('renders nothing when no projectId is provided (no context to act on)', () => {
    useMonteCarloResultSpy.mockReturnValue({ data: undefined, isLoading: false, error: null });
    const { container } = renderWithProviders(<MobileMonteCarloCard />);
    expect(container.firstChild).toBeNull();
  });

  it('forwards projectId to useMonteCarloResult', () => {
    renderWithProviders(<MobileMonteCarloCard projectId="proj-xyz" />);
    expect(useMonteCarloResultSpy).toHaveBeenCalledWith('proj-xyz');
  });

  describe('empty state — no simulation cached', () => {
    beforeEach(() => {
      useMonteCarloResultSpy.mockReturnValue({ data: undefined, isLoading: false, error: null });
    });

    it('renders a "Run Monte Carlo" CTA in place of the chips', () => {
      renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
      const cta = screen.getByRole('button', {
        name: /Run Monte Carlo simulation to see confidence dates/i,
      });
      expect(cta).toBeInTheDocument();
      expect(cta).toHaveTextContent(/No forecast yet\./);
      expect(cta).toHaveTextContent(/Run Monte Carlo/);
    });

    it('CTA still meets the 44px tap-target floor (rule 5)', () => {
      renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
      const cta = screen.getByRole('button', {
        name: /Run Monte Carlo simulation to see confidence dates/i,
      });
      expect(cta.className).toMatch(/min-h-11/);
      expect(cta.className).toMatch(/\bmd:hidden\b/);
    });

    it('clicking the CTA fires the run mutation', () => {
      renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
      fireEvent.click(
        screen.getByRole('button', {
          name: /Run Monte Carlo simulation to see confidence dates/i,
        }),
      );
      expect(runMutate).toHaveBeenCalledTimes(1);
    });

    it('disables the CTA and shows "Running…" while the mutation is pending', () => {
      runState = { isPending: true, isError: false };
      renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
      const cta = screen.getByRole('button', {
        name: /Run Monte Carlo simulation to see confidence dates/i,
      });
      expect(cta).toBeDisabled();
      expect(cta).toHaveTextContent(/Running…/);
    });

    it('shows the loading copy while the latest-MC query is loading', () => {
      useMonteCarloResultSpy.mockReturnValue({ data: undefined, isLoading: true, error: null });
      renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
      expect(screen.getByText(/Loading forecast…/i)).toBeInTheDocument();
    });

    it('shows a retry message when the run mutation errored', () => {
      runState = { isPending: false, isError: true };
      renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
      expect(screen.getByText(/Could not run simulation\./i)).toBeInTheDocument();
      expect(screen.getByRole('button')).toHaveTextContent(/Try again/);
    });
  });
});
