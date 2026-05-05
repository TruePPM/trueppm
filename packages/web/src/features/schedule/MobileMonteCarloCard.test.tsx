import { screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import { MobileMonteCarloCard } from './MobileMonteCarloCard';

const useMonteCarloResultSpy = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: (projectId?: string) => useMonteCarloResultSpy(projectId),
}));

beforeEach(() => {
  useMonteCarloResultSpy.mockReset();
  useMonteCarloResultSpy.mockReturnValue({
    data: FIXTURE_MC_RESULT,
    isLoading: false,
    error: null,
  });
});

describe('MobileMonteCarloCard (#33)', () => {
  it('renders P50/P80/P95 chips with dates', () => {
    renderWithProviders(<MobileMonteCarloCard />);
    const button = screen.getByRole('button', { name: /Monte Carlo confidence/ });
    expect(button).toHaveTextContent(/P50:/);
    expect(button).toHaveTextContent(/P80:/);
    expect(button).toHaveTextContent(/P95:/);
  });

  it('tap target meets the 44px minimum (rule 5)', () => {
    renderWithProviders(<MobileMonteCarloCard />);
    const button = screen.getByRole('button', { name: /Monte Carlo confidence/ });
    // `min-h-11` = 44px floor
    expect(button.className).toMatch(/min-h-11/);
  });

  it('is suppressed at md and above (md:hidden class present)', () => {
    renderWithProviders(<MobileMonteCarloCard />);
    const button = screen.getByRole('button', { name: /Monte Carlo confidence/ });
    expect(button.className).toMatch(/\bmd:hidden\b/);
  });

  it('opens the histogram sheet on tap and closes on Escape', () => {
    renderWithProviders(<MobileMonteCarloCard />);
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

  it('renders nothing when the hook has no data (empty / not-run state)', () => {
    useMonteCarloResultSpy.mockReturnValue({ data: undefined, isLoading: false, error: null });
    const { container } = renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
    expect(container.firstChild).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Monte Carlo confidence/ }),
    ).not.toBeInTheDocument();
  });

  it('renders nothing while the hook is loading', () => {
    useMonteCarloResultSpy.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { container } = renderWithProviders(<MobileMonteCarloCard projectId="proj-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('forwards projectId to useMonteCarloResult', () => {
    renderWithProviders(<MobileMonteCarloCard projectId="proj-xyz" />);
    expect(useMonteCarloResultSpy).toHaveBeenCalledWith('proj-xyz');
  });

  it('calls useMonteCarloResult with undefined when no projectId is provided', () => {
    renderWithProviders(<MobileMonteCarloCard />);
    expect(useMonteCarloResultSpy).toHaveBeenCalledWith(undefined);
  });
});
