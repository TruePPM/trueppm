import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { UseMonteCarloResultReturn } from '@/hooks/useMonteCarloResult';
import { FIXTURE_MC_RESULT } from '@/fixtures/monteCarlo';
import { FIXTURE_TASKS } from '@/fixtures/tasks';
import { ScheduleInsightsBar } from './ScheduleInsightsBar';

let mockMcReturn: UseMonteCarloResultReturn = { data: undefined, isLoading: false, error: null };
vi.mock('@/hooks/useMonteCarloResult', () => ({
  useMonteCarloResult: () => mockMcReturn,
}));

// MonteCarloHistogram renders an SVG; keep it real (it only needs the result).

describe('ScheduleInsightsBar (issue 1222)', () => {
  beforeEach(() => {
    localStorage.removeItem('schedule.insightsExpanded');
    mockMcReturn = { data: FIXTURE_MC_RESULT, isLoading: false, error: null };
  });

  it('renders nothing until a simulation result exists', () => {
    mockMcReturn = { data: undefined, isLoading: false, error: null };
    const { container } = render(<ScheduleInsightsBar projectId="p1" tasks={FIXTURE_TASKS} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is collapsed by default and shows the one-line summary with the top driver', () => {
    render(<ScheduleInsightsBar projectId="p1" tasks={FIXTURE_TASKS} />);
    const toggle = screen.getByRole('button', { name: /Forecast & sensitivity/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Summary line carries the percentiles and the top driver (t3 = Backend Implementation).
    expect(screen.getByText(/P80/)).toBeInTheDocument();
    expect(screen.getByText(/top driver: Backend Implementation/)).toBeInTheDocument();
    // Collapsed → the two-column body is not mounted.
    expect(screen.queryByText('Finish-date forecast')).not.toBeInTheDocument();
  });

  it('expands to the two-column forecast + sensitivity panel and persists the choice', () => {
    render(<ScheduleInsightsBar projectId="p1" tasks={FIXTURE_TASKS} />);
    fireEvent.click(screen.getByRole('button', { name: /Forecast & sensitivity/i }));

    expect(screen.getByRole('button', { name: /Forecast & sensitivity/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('Finish-date forecast')).toBeInTheDocument();
    expect(screen.getByText(/What.s holding the date/i)).toBeInTheDocument();
    // Sensitivity bars are joined to task names from the fixture.
    expect(screen.getByText('Backend Implementation')).toBeInTheDocument();
    expect(localStorage.getItem('schedule.insightsExpanded')).toBe('true');
  });

  it('opens expanded when the persisted preference is set', () => {
    localStorage.setItem('schedule.insightsExpanded', 'true');
    render(<ScheduleInsightsBar projectId="p1" tasks={FIXTURE_TASKS} />);
    expect(screen.getByRole('button', { name: /Forecast & sensitivity/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('Finish-date forecast')).toBeInTheDocument();
  });
});
