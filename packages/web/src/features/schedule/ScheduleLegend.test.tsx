import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScheduleLegend } from './ScheduleLegend';

const STORAGE_KEY = 'trueppm.schedule.legend.collapsed.v1';

describe('ScheduleLegend', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders expanded by default with all ten entries', () => {
    render(<ScheduleLegend taskListWidth={240} canLink />);
    expect(screen.getByTestId('schedule-legend-body')).toBeInTheDocument();
    // Row 1 — bar variants
    expect(screen.getByText('Summary rollup')).toBeInTheDocument();
    expect(screen.getByText('Task (progress)')).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
    // Row 2 — state markers
    expect(screen.getByText('Critical path')).toBeInTheDocument();
    expect(screen.getByText('Milestone')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    // Row 3 — delivery mode (#2727 pt.7)
    expect(screen.getByText('Scrum')).toBeInTheDocument();
    expect(screen.getByText('Kanban')).toBeInTheDocument();
    // Row 4 — lines & arrows
    expect(screen.getByText('Finish-to-start')).toBeInTheDocument();
    expect(screen.getByText('Merged trunk')).toBeInTheDocument();
  });

  it('does not name a "Planned baseline" mark the canvas never draws (ADR-0376)', () => {
    // ADR-0376 keeps the baseline ghost-bar overlay out of 0.4; the comparison
    // table is the variance surface. A legend entry for an undrawn mark tells the
    // reader the overlay exists. Reinstate this row when the overlay lands in 0.5.
    render(<ScheduleLegend taskListWidth={240} canLink />);
    expect(screen.queryByText('Planned baseline')).not.toBeInTheDocument();
  });

  it('renders the Task (progress) swatch in the brand info blue that matches the canvas bar (#1700)', () => {
    // The normal-task swatch fill is now var(--info) (== COLOR.barNormal), so the
    // legend describes the actual blue bars — it no longer shows sage, which never
    // matched the canvas normal-task fill.
    const { container } = render(<ScheduleLegend taskListWidth={240} canLink />);
    expect(container.querySelector('span[style*="var(--info)"]')).not.toBeNull();
  });

  it('surfaces the interaction hints (pan + open details) in the legend body', () => {
    // The bar cursor is `grab`, so the timeline reads as drag-only; these two
    // quiet lines are the discoverability surface for pan and "open details"
    // (the legend is the established affordance-explanation surface, rule 132).
    render(<ScheduleLegend taskListWidth={240} canLink />);
    expect(screen.getByText('Hold Space + drag, or middle-drag, to pan')).toBeInTheDocument();
    expect(screen.getByText('Double-click a task to open its details')).toBeInTheDocument();
  });

  it('chip is a button with aria-expanded=true when expanded', () => {
    render(<ScheduleLegend taskListWidth={240} canLink />);
    const chip = screen.getByTestId('schedule-legend-chip');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(chip.getAttribute('aria-controls')).toBe(
      screen.getByTestId('schedule-legend-body').id,
    );
  });

  it('clicking the chip collapses the body and updates aria-expanded', () => {
    render(<ScheduleLegend taskListWidth={240} canLink />);
    const chip = screen.getByTestId('schedule-legend-chip');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('schedule-legend-body')).toHaveAttribute('hidden');
  });

  it('persists collapsed state to localStorage', () => {
    render(<ScheduleLegend taskListWidth={240} canLink />);
    fireEvent.click(screen.getByTestId('schedule-legend-chip'));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('reads collapsed state from localStorage on mount', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    render(<ScheduleLegend taskListWidth={240} canLink />);
    const chip = screen.getByTestId('schedule-legend-chip');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('schedule-legend-body')).toHaveAttribute('hidden');
  });

  it('positions horizontally based on taskListWidth prop', () => {
    const { rerender } = render(<ScheduleLegend taskListWidth={240} canLink />);
    expect(screen.getByTestId('schedule-legend')).toHaveStyle({ left: '256px' });
    rerender(<ScheduleLegend taskListWidth={320} canLink />);
    expect(screen.getByTestId('schedule-legend')).toHaveStyle({ left: '336px' });
  });

  it('body is suppressed on small viewports via Tailwind (hidden lg:block)', () => {
    render(<ScheduleLegend taskListWidth={240} canLink />);
    expect(screen.getByTestId('schedule-legend').className).toContain('hidden');
    expect(screen.getByTestId('schedule-legend').className).toContain('lg:block');
  });

  // Standing copy follows the affordance (#3053). Since the engine stopped
  // painting the link handle for a reader who may not author dependency edges,
  // leaving this line up sends them hunting for a dot that is genuinely not
  // there — and the conclusion they reach is "the canvas failed to render",
  // not "I lack a permission". Withheld instructions, not just a withheld dot.
  it('names the drag-to-link handle when the gesture is on offer', () => {
    render(<ScheduleLegend taskListWidth={240} canLink />);
    expect(screen.getByText(/handle at a bar’s right edge/)).toBeInTheDocument();
  });

  it('drops the drag-to-link line when the gesture is withheld', () => {
    render(<ScheduleLegend taskListWidth={240} canLink={false} />);
    expect(screen.queryByText(/handle at a bar’s right edge/)).not.toBeInTheDocument();
    // The rest of the legend is unaffected — this withholds one line, not the panel.
    expect(screen.getByTestId('schedule-legend')).toBeInTheDocument();
    expect(screen.getByText(/Double-click a task to open its details/)).toBeInTheDocument();
  });
});
