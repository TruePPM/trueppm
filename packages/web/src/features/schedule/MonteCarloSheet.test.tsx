import { screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, renderWithRouter } from '@/test/utils';
import { MonteCarloSheet } from './MonteCarloSheet';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import { ADDED_TIME_FIXTURES } from '@/fixtures/addedTime';

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

  // Escape is owned by `useFocusTrap`, which listens on `document` (#2531 —
  // the sheet declares `aria-modal` and now contains focusable content, so it
  // needed a real trap rather than a mount-focus plus a `window` listener).
  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    renderWithProviders(<MonteCarloSheet result={FIXTURE_MC_RESULT} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose for non-Escape key presses', () => {
    const onClose = vi.fn();
    renderWithProviders(<MonteCarloSheet result={FIXTURE_MC_RESULT} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the sheet — it declares aria-modal, so it must trap (rule 206)', () => {
    const onClose = vi.fn();
    renderWithProviders(<MonteCarloSheet result={FIXTURE_MC_RESULT} onClose={onClose} />);
    const close = screen.getByRole('button', { name: /Close Monte Carlo detail/i });
    // The close button is first in DOM order, so it takes the initial seat.
    expect(close).toHaveFocus();
    // Shift+Tab off the first focusable wraps to the last rather than escaping
    // behind the scrim.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('renders added time at the top, from the same premium the Overview card reads (#2531)', () => {
    const onClose = vi.fn();
    renderWithProviders(<MonteCarloSheet result={FIXTURE_MC_RESULT} onClose={onClose} />);
    const card = screen.getByRole('region', { name: /added time vs computed finish/i });
    expect(card).toBeInTheDocument();
    // FIXTURE_MC_RESULT's premium is +29d over a computed finish of Oct 5.
    expect(card).toHaveTextContent('+29d');
  });

  it('offers the estimate remedy — and only it — when the forecast could not be measured', () => {
    const onClose = vi.fn();
    // Router-aware: this is the one state whose card renders a `<Link>`.
    renderWithRouter(
      <MonteCarloSheet
        result={{
          ...FIXTURE_MC_RESULT,
          riskPremium: ADDED_TIME_FIXTURES.unmeasurable,
        }}
        onClose={onClose}
      />,
    );
    const card = screen.getByRole('region', { name: /added time vs computed finish/i });
    expect(card).toHaveTextContent("Can't be measured yet");
    // "Add estimates →" goes somewhere the reader is not; a "Forecast →" link
    // would point at the screen this sheet was opened from.
    expect(within(card).getByRole('link', { name: /add estimates/i })).toBeInTheDocument();
  });

  it('offers the rerun remedy when the SERVER says the plan moved, not only on age (#3140)', () => {
    // The sheet is the only rerun path a phone user has. `risk_premium_state`'s
    // `stale` is age-only, so before #3140 a plan edited five minutes ago left the
    // desktop bar offering Rerun while this sheet dead-ended. Drop
    // `forecastStaleness` from the condition and this fails.
    const onClose = vi.fn();
    renderWithRouter(
      <MonteCarloSheet
        result={{ ...FIXTURE_MC_RESULT, forecastStaleness: 'projectChanged' }}
        onClose={onClose}
      />,
    );
    const card = screen.getByRole('region', { name: /added time vs computed finish/i });
    expect(within(card).getByRole('link', { name: /re-run forecast/i })).toBeInTheDocument();
  });

  it('withholds the rerun remedy while the server reports the forecast current', () => {
    // The other half of the pair — without this the test above passes on a build
    // that simply always shows the link.
    const onClose = vi.fn();
    renderWithRouter(
      <MonteCarloSheet
        result={{ ...FIXTURE_MC_RESULT, forecastStaleness: 'current' }}
        onClose={onClose}
      />,
    );
    const card = screen.getByRole('region', { name: /added time vs computed finish/i });
    expect(within(card).queryByRole('link', { name: /re-run forecast/i })).not.toBeInTheDocument();
  });
});
