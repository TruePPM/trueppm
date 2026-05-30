import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScheduleLegend } from './ScheduleLegend';

const STORAGE_KEY = 'trueppm.schedule.legend.collapsed.v1';

describe('ScheduleLegend', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders expanded by default with all nine entries', () => {
    render(<ScheduleLegend taskListWidth={240} />);
    expect(screen.getByTestId('schedule-legend-body')).toBeInTheDocument();
    // Row 1 — bar variants
    expect(screen.getByText('Summary rollup')).toBeInTheDocument();
    expect(screen.getByText('Task (progress)')).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
    // Row 2 — state markers
    expect(screen.getByText('Critical path')).toBeInTheDocument();
    expect(screen.getByText('Milestone')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    // Row 3 — lines & arrows
    expect(screen.getByText('Planned baseline')).toBeInTheDocument();
    expect(screen.getByText('Finish-to-start')).toBeInTheDocument();
    expect(screen.getByText('Merged trunk')).toBeInTheDocument();
  });

  it('surfaces the interaction hints (pan + open details) in the legend body', () => {
    // The bar cursor is `grab`, so the timeline reads as drag-only; these two
    // quiet lines are the discoverability surface for pan and "open details"
    // (the legend is the established affordance-explanation surface, rule 132).
    render(<ScheduleLegend taskListWidth={240} />);
    expect(screen.getByText('Hold Space + drag, or middle-drag, to pan')).toBeInTheDocument();
    expect(screen.getByText('Double-click a task to open its details')).toBeInTheDocument();
  });

  it('chip is a button with aria-expanded=true when expanded', () => {
    render(<ScheduleLegend taskListWidth={240} />);
    const chip = screen.getByTestId('schedule-legend-chip');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(chip.getAttribute('aria-controls')).toBe(
      screen.getByTestId('schedule-legend-body').id,
    );
  });

  it('clicking the chip collapses the body and updates aria-expanded', () => {
    render(<ScheduleLegend taskListWidth={240} />);
    const chip = screen.getByTestId('schedule-legend-chip');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('schedule-legend-body')).toHaveAttribute('hidden');
  });

  it('persists collapsed state to localStorage', () => {
    render(<ScheduleLegend taskListWidth={240} />);
    fireEvent.click(screen.getByTestId('schedule-legend-chip'));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('reads collapsed state from localStorage on mount', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    render(<ScheduleLegend taskListWidth={240} />);
    const chip = screen.getByTestId('schedule-legend-chip');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('schedule-legend-body')).toHaveAttribute('hidden');
  });

  it('positions horizontally based on taskListWidth prop', () => {
    const { rerender } = render(<ScheduleLegend taskListWidth={240} />);
    expect(screen.getByTestId('schedule-legend')).toHaveStyle({ left: '256px' });
    rerender(<ScheduleLegend taskListWidth={320} />);
    expect(screen.getByTestId('schedule-legend')).toHaveStyle({ left: '336px' });
  });

  it('body is suppressed on small viewports via Tailwind (hidden lg:block)', () => {
    render(<ScheduleLegend taskListWidth={240} />);
    expect(screen.getByTestId('schedule-legend').className).toContain('hidden');
    expect(screen.getByTestId('schedule-legend').className).toContain('lg:block');
  });
});
