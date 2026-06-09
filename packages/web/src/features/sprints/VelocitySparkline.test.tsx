import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';

import { VelocitySparkline } from './VelocitySparkline';
import type { ProjectVelocity, VelocitySprintEntry } from '@/hooks/useSprints';

function entry(overrides: Partial<VelocitySprintEntry> = {}): VelocitySprintEntry {
  return {
    id: 's',
    name: 'Sprint',
    start_date: '2026-01-01',
    finish_date: '2026-01-14',
    committed_points: 30,
    completed_points: 30,
    committed_task_count: 5,
    completed_task_count: 5,
    exclude_from_velocity: overrides.exclude_from_velocity ?? false,
    ...overrides,
  };
}

function velocity(overrides: Partial<ProjectVelocity> = {}): ProjectVelocity {
  return {
    sprints: [],
    rolling_avg_points: null,
    rolling_stdev_points: null,
    forecast_range_low: null,
    forecast_range_high: null,
    rolling_avg_tasks: null,
    rolling_stdev_tasks: null,
    team_velocity_per_day: null,
    excluded_count: 0,
    ...overrides,
  };
}

describe('VelocitySparkline', () => {
  it('renders a loading skeleton when isLoading', () => {
    render(<VelocitySparkline velocity={undefined} isLoading />);
    expect(screen.getByRole('status', { name: /loading velocity/i })).toBeInTheDocument();
  });

  it('renders empty-state copy when no closed sprints exist', () => {
    render(<VelocitySparkline velocity={velocity()} />);
    expect(screen.getByText(/no closed sprints/i)).toBeInTheDocument();
    expect(screen.getByText(/velocity unlocks/i)).toBeInTheDocument();
  });

  it('renders single-sprint caption when only one completed sprint', () => {
    render(
      <VelocitySparkline
        velocity={velocity({
          sprints: [entry({ id: '1', completed_points: 20 })],
        })}
      />,
    );
    expect(screen.getByText('20 pts')).toBeInTheDocument();
    expect(screen.getByText(/trend unlocks at 2/i)).toBeInTheDocument();
  });

  it('renders bars and average caption with multiple sprints', () => {
    const sprints = [
      entry({ id: '1', completed_points: 20 }),
      entry({ id: '2', completed_points: 25 }),
      entry({ id: '3', completed_points: 30 }),
      entry({ id: '4', completed_points: 38 }),
    ];
    render(
      <VelocitySparkline
        velocity={velocity({
          sprints,
          rolling_avg_points: 28,
          rolling_stdev_points: 4,
        })}
      />,
    );
    expect(screen.getByText('38 pts')).toBeInTheDocument();
    expect(screen.getByText(/avg 28 ± 4 \/ sprint/i)).toBeInTheDocument();
    const svg = screen.getByRole('img');
    expect(svg).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Velocity over last 4 sprints'),
    );
    expect(svg).toHaveAttribute('aria-label', expect.stringContaining('20, 25, 30, 38'));
  });

  it('exposes the min–max band and P50 median in the aria-label', () => {
    const sprints = [20, 25, 30, 38].map((p, i) =>
      entry({ id: `${i}`, completed_points: p }),
    );
    render(<VelocitySparkline velocity={velocity({ sprints })} />);
    const svg = screen.getByRole('img');
    // median of [20,25,30,38] = 27.5 → rounded 28; range = min–max.
    expect(svg).toHaveAttribute(
      'aria-label',
      expect.stringContaining('range 20–38 points, median 28'),
    );
  });

  it('omits the band when the series is degenerate (all equal)', () => {
    const sprints = [
      entry({ id: '1', completed_points: 30 }),
      entry({ id: '2', completed_points: 30 }),
    ];
    render(<VelocitySparkline velocity={velocity({ sprints })} />);
    const svg = screen.getByRole('img');
    // min === max → no band, so no "range" clause in the label.
    expect(svg).toHaveAttribute('aria-label', expect.not.stringContaining('range'));
  });

  it('drops sprints with null completed_points (still open)', () => {
    const sprints = [
      entry({ id: '1', completed_points: 20 }),
      entry({ id: '2', completed_points: null }),
      entry({ id: '3', completed_points: 30 }),
    ];
    render(
      <VelocitySparkline velocity={velocity({ sprints, rolling_avg_points: 25 })} />,
    );
    expect(screen.getByText('30 pts')).toBeInTheDocument();
    const svg = screen.getByRole('img');
    expect(svg).toHaveAttribute('aria-label', expect.stringContaining('20, 30'));
  });

  it('caps the rendered series at 8 sprints', () => {
    const sprints = Array.from({ length: 12 }, (_, i) =>
      entry({ id: `s${i}`, completed_points: 10 + i }),
    );
    render(<VelocitySparkline velocity={velocity({ sprints })} />);
    // Latest of the trailing 8 is index 11 → completed_points = 21.
    expect(screen.getByText('21 pts')).toBeInTheDocument();
    const svg = screen.getByRole('img');
    expect(svg).toHaveAttribute('aria-label', expect.stringContaining('last 8 sprints'));
  });

  it('omits ± stdev when stdev is zero', () => {
    const sprints = [
      entry({ id: '1', completed_points: 30 }),
      entry({ id: '2', completed_points: 30 }),
    ];
    render(
      <VelocitySparkline
        velocity={velocity({
          sprints,
          rolling_avg_points: 30,
          rolling_stdev_points: 0,
        })}
      />,
    );
    expect(screen.getByText(/avg 30 \/ sprint/i)).toBeInTheDocument();
    expect(screen.queryByText(/±/)).not.toBeInTheDocument();
  });

  // ADR-0113: an excluded sprint renders hollow (outline only) and is held out
  // of the band/median, but is still shown and announced.
  it('excludes a flagged sprint from the band and announces it', () => {
    const sprints = [
      entry({ id: '0', name: 'Sprint 0', completed_points: 4, exclude_from_velocity: true }),
      entry({ id: '1', completed_points: 30 }),
      entry({ id: '2', completed_points: 30 }),
    ];
    const { container } = render(<VelocitySparkline velocity={velocity({ sprints })} />);
    const svg = screen.getByRole('img');
    // The eligible series [30, 30] is degenerate → no band, even though the
    // excluded 4-pt sprint would otherwise widen the range to 4–30.
    expect(svg).toHaveAttribute('aria-label', expect.not.stringContaining('range'));
    expect(svg).toHaveAttribute('aria-label', expect.stringContaining('1 excluded from velocity'));
    // The hollow bar is rendered (fill="none"), not dropped.
    const hollow = container.querySelector('rect[fill="none"]');
    expect(hollow).toBeInTheDocument();
  });
});
