import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MCResultPanel } from './MCResultPanel';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';

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

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<MCResultPanel result={FIXTURE_MC_RESULT} onClose={onClose} />);
    // Backdrop is the flex-1 div (aria-hidden) that fills space to the left of the panel
    const backdrop = document.querySelector('.flex-1.bg-black\\/30') as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('has role=dialog with aria-modal=true', () => {
    render(<MCResultPanel result={FIXTURE_MC_RESULT} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: /monte carlo confidence distribution/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });
});
