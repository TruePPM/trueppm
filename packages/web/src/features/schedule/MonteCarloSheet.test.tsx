import { screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { MonteCarloSheet } from './MonteCarloSheet';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';

// The sheet embeds ForecastHistorySection (ADR-0175); mock the client so its
// history fetch resolves empty and the section stays out of these chrome tests.
vi.mock('@/api/client', () => ({
  apiClient: { get: vi.fn().mockResolvedValue({ data: { results: [], cap: 100 } }) },
}));

describe('MonteCarloSheet', () => {
  it('renders as a dialog with the correct aria attributes', () => {
    const onClose = vi.fn();
    renderWithProviders(<MonteCarloSheet result={FIXTURE_MC_RESULT} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: /Monte Carlo confidence distribution/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('renders the p80 date in the subtitle (locale-formatted)', () => {
    const onClose = vi.fn();
    renderWithProviders(<MonteCarloSheet result={FIXTURE_MC_RESULT} onClose={onClose} />);
    // p80 fixture is '2026-11-03'; rendered via fmtForecastDate → "Nov 2/3, 2026"
    // (tz-tolerant since ISO midnight may shift a day in the local zone).
    expect(screen.getByText(/Nov [23], 2026/)).toBeInTheDocument();
  });

  it('renders the close button', () => {
    const onClose = vi.fn();
    renderWithProviders(<MonteCarloSheet result={FIXTURE_MC_RESULT} onClose={onClose} />);
    expect(screen.getByRole('button', { name: /Close Monte Carlo detail/i })).toBeInTheDocument();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    renderWithProviders(<MonteCarloSheet result={FIXTURE_MC_RESULT} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Close Monte Carlo detail/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the backdrop area is clicked', () => {
    const onClose = vi.fn();
    renderWithProviders(<MonteCarloSheet result={FIXTURE_MC_RESULT} onClose={onClose} />);
    const backdrop = screen.getByRole('dialog').querySelector('[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    renderWithProviders(<MonteCarloSheet result={FIXTURE_MC_RESULT} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose for non-Escape key presses', () => {
    const onClose = vi.fn();
    renderWithProviders(<MonteCarloSheet result={FIXTURE_MC_RESULT} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
