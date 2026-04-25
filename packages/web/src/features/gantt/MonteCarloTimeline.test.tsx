import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MonteCarloTimeline } from './MonteCarloTimeline';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';

describe('MonteCarloTimeline', () => {
  it('renders the interactive button element', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    const btn = screen.getByRole('button');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders permanently-visible P50, P80, P95 chips', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    // Chips include the label text "P50", "P80", "P95" always visible
    expect(screen.getByText(/^P50/)).toBeInTheDocument();
    expect(screen.getByText(/^P80/)).toBeInTheDocument();
    expect(screen.getByText(/^P95/)).toBeInTheDocument();
  });

  it('does not render a loading placeholder (histogram is always shown)', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('opens the histogram dialog on mouse enter', async () => {
    const user = userEvent.setup();
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    const btn = screen.getByRole('button');
    await user.hover(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes the histogram dialog on mouse leave', async () => {
    const user = userEvent.setup();
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    const btn = screen.getByRole('button');
    await user.hover(btn);
    await user.unhover(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the histogram dialog on Enter keypress', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    const btn = screen.getByRole('button');
    fireEvent.keyDown(btn, { key: 'Enter', code: 'Enter' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens the histogram dialog on Space keypress', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    const btn = screen.getByRole('button');
    fireEvent.keyDown(btn, { key: ' ', code: 'Space' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes an open dialog on Escape keypress', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    const btn = screen.getByRole('button');
    fireEvent.keyDown(btn, { key: 'Enter', code: 'Enter' }); // open
    fireEvent.keyDown(btn, { key: 'Escape', code: 'Escape' }); // close
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles: second Enter press closes the dialog', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    const btn = screen.getByRole('button');
    fireEvent.keyDown(btn, { key: 'Enter', code: 'Enter' }); // open
    fireEvent.keyDown(btn, { key: 'Enter', code: 'Enter' }); // close
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the dialog on focus and closes on blur', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} />);
    const btn = screen.getByRole('button');
    fireEvent.focus(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    fireEvent.blur(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
});
