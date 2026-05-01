import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { VelocityPanel } from './VelocityPanel';
import type { ProjectVelocity, VelocitySprintEntry } from '@/hooks/useSprints';

function makeSprint(overrides: Partial<VelocitySprintEntry>): VelocitySprintEntry {
  return {
    id: overrides.id ?? 'sp',
    name: overrides.name ?? 'Sprint',
    start_date: '2026-01-01',
    finish_date: '2026-01-14',
    committed_points: overrides.committed_points ?? 30,
    completed_points: overrides.completed_points ?? 30,
    committed_task_count: 10,
    completed_task_count: 10,
    ...overrides,
  };
}

function makeVelocity(overrides: Partial<ProjectVelocity> = {}): ProjectVelocity {
  return {
    sprints: [],
    rolling_avg_points: null,
    rolling_stdev_points: null,
    forecast_range_low: null,
    forecast_range_high: null,
    rolling_avg_tasks: null,
    rolling_stdev_tasks: null,
    ...overrides,
  };
}

describe('VelocityPanel', () => {
  it('renders the rolling avg ± stdev', () => {
    render(
      <VelocityPanel
        velocity={makeVelocity({
          sprints: [makeSprint({})],
          rolling_avg_points: 38.5,
          rolling_stdev_points: 6.2,
          forecast_range_low: 32,
          forecast_range_high: 45,
        })}
      />,
    );
    expect(screen.getByText(/38.5/)).toBeInTheDocument();
    expect(screen.getByText(/6.2/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Forecast range 32 to 45 points/)).toBeInTheDocument();
  });

  it('shows the empty-state copy when no closed sprints exist', () => {
    render(<VelocityPanel velocity={makeVelocity()} />);
    expect(screen.getByText(/No closed sprints yet/i)).toBeInTheDocument();
  });

  it('omits the forecast chip when forecast bounds are null', () => {
    render(
      <VelocityPanel
        velocity={makeVelocity({
          sprints: [makeSprint({})],
          rolling_avg_points: 30,
        })}
      />,
    );
    expect(screen.queryByLabelText(/Forecast range/)).not.toBeInTheDocument();
  });

  it('links to ADR-0036 in the footer', () => {
    render(<VelocityPanel velocity={makeVelocity({ sprints: [makeSprint({})] })} />);
    const link = screen.getByRole('link', { name: 'ADR-0036' });
    expect(link).toHaveAttribute('href', expect.stringContaining('0036-hybrid-pm-philosophy'));
  });
});
