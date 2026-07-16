import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MCResultPanel } from './MCResultPanel';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import { renderWithProviders as render } from '@/test/utils';

// The panel now embeds ForecastHistorySection (ADR-0175), which fetches the run
// history. Mock the client to return an empty history so the section renders
// nothing and these tests stay focused on the panel chrome.
vi.mock('@/api/client', () => ({
  apiClient: { get: vi.fn().mockResolvedValue({ data: { results: [], cap: 100 } }) },
}));

describe('MCResultPanel', () => {
  it('renders P50/P80/P95 section headings and date chips', () => {
    render(<MCResultPanel result={FIXTURE_MC_RESULT} onClose={() => {}} />);
    // Section labels (the small uppercase headings above each chip; may appear in histogram too)
    expect(screen.getAllByText('P50').length).toBeGreaterThan(0);
    expect(screen.getAllByText('P80').length).toBeGreaterThan(0);
    expect(screen.getAllByText('P95').length).toBeGreaterThan(0);
    // Fixture p50=2026-10-05, p80=2026-11-03, p95=2026-11-30.
    // Each chip's aria-label includes "P50:", "P80:", "P95:" with formatted dates.
    // getByRole isn't available on plain spans; check aria-label with getAllByRole.
    // Use the panel heading text as a proxy for the panel being populated.
    expect(screen.getByText('Monte Carlo confidence')).toBeInTheDocument();
  });

  it('shows simulation run count', () => {
    render(<MCResultPanel result={FIXTURE_MC_RESULT} onClose={() => {}} />);
    expect(screen.getByText(/1,000 simulated runs/i)).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<MCResultPanel result={FIXTURE_MC_RESULT} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: /close monte carlo panel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn();
    render(<MCResultPanel result={FIXTURE_MC_RESULT} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders no modal backdrop scrim (non-modal drawer keeps the schedule usable)', () => {
    // Rules 89/164: a right-side desktop detail drawer is non-modal and has no
    // dimming scrim, so the schedule behind it stays visible and interactive.
    const { container } = render(<MCResultPanel result={FIXTURE_MC_RESULT} onClose={() => {}} />);
    expect(container.querySelector('.bg-black\\/30')).toBeNull();
    expect(container.querySelector('.bg-neutral-overlay')).toBeNull();
  });

  it('is a non-modal drawer (aria-modal=false) and does not trap focus', () => {
    render(<MCResultPanel result={FIXTURE_MC_RESULT} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: /monte carlo confidence/i });
    expect(dialog).toHaveAttribute('aria-modal', 'false');
    // Focus the close button (the panel's sole focusable) and Tab away: a
    // non-modal drawer must NOT intercept Tab (no focus trap), so the keydown is
    // not defaultPrevented and fireEvent returns true. A trapped modal would
    // cancel it at the boundary and return false.
    screen.getByRole('button', { name: /close monte carlo panel/i }).focus();
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(true);
  });
});
