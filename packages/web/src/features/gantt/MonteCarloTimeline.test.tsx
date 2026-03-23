import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MonteCarloTimeline } from './MonteCarloTimeline';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import type { GanttScaleData } from '@svar-ui/gantt-store/dist/types/types';

/**
 * Minimal GanttScaleData stub that satisfies the date → pixel maths inside
 * MonteCarloTimeline.dateToLeft(). Using calendar-day units so the expected
 * left values are easy to reason about.
 */
const MOCK_SCALES: GanttScaleData = {
  width: 1000,
  start: new Date('2026-01-01'),
  end: new Date('2027-01-01'),
  // Return the difference in whole calendar days
  diff: (a: Date, b: Date) =>
    Math.round((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24)),
} as unknown as GanttScaleData;

describe('MonteCarloTimeline', () => {
  it('renders the interactive button element', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} scrollLeft={0} scales={null} />);
    const btn = screen.getByRole('button');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows loading placeholder when scales are not yet available', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} scrollLeft={0} scales={null} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('hides loading placeholder once scales are provided', () => {
    render(
      <MonteCarloTimeline result={FIXTURE_MC_RESULT} scrollLeft={0} scales={MOCK_SCALES} />,
    );
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('opens the histogram dialog on mouse enter', async () => {
    const user = userEvent.setup();
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} scrollLeft={0} scales={null} />);
    const btn = screen.getByRole('button');
    await user.hover(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes the histogram dialog on mouse leave', async () => {
    const user = userEvent.setup();
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} scrollLeft={0} scales={null} />);
    const btn = screen.getByRole('button');
    await user.hover(btn);
    await user.unhover(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the histogram dialog on Enter keypress', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} scrollLeft={0} scales={null} />);
    const btn = screen.getByRole('button');
    // fireEvent does not implicitly focus first, so isOpen is false going in
    fireEvent.keyDown(btn, { key: 'Enter', code: 'Enter' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens the histogram dialog on Space keypress', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} scrollLeft={0} scales={null} />);
    const btn = screen.getByRole('button');
    fireEvent.keyDown(btn, { key: ' ', code: 'Space' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes an open dialog on Escape keypress', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} scrollLeft={0} scales={null} />);
    const btn = screen.getByRole('button');
    fireEvent.keyDown(btn, { key: 'Enter', code: 'Enter' }); // open
    fireEvent.keyDown(btn, { key: 'Escape', code: 'Escape' }); // close
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles: second Enter press closes the dialog', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} scrollLeft={0} scales={null} />);
    const btn = screen.getByRole('button');
    fireEvent.keyDown(btn, { key: 'Enter', code: 'Enter' }); // open
    fireEvent.keyDown(btn, { key: 'Enter', code: 'Enter' }); // close
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the dialog on focus and closes on blur', () => {
    render(<MonteCarloTimeline result={FIXTURE_MC_RESULT} scrollLeft={0} scales={null} />);
    const btn = screen.getByRole('button');
    // showAtCenter calls getBoundingClientRect(); jsdom returns 0s, which is fine
    fireEvent.focus(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    fireEvent.blur(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
});
