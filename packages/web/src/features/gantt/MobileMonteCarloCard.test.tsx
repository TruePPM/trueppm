import { screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { MobileMonteCarloCard } from './MobileMonteCarloCard';

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
});
