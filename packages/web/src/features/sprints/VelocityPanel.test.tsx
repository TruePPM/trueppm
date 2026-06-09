import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
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
    exclude_from_velocity: overrides.exclude_from_velocity ?? false,
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
    team_velocity_per_day: null,
    excluded_count: 0,
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

  // Bar colour is the only sighted health signal; the <title> must carry the
  // same classification as a non-color cue for screen-reader users (#1028).
  it('encodes the health band as a non-color signal in each bar title', () => {
    const { container } = render(
      <VelocityPanel
        velocity={makeVelocity({
          sprints: [
            makeSprint({ id: 'a', name: 'S1', committed_points: 20, completed_points: 20 }), // 1.0 → on track
            makeSprint({ id: 'b', name: 'S2', committed_points: 20, completed_points: 14 }), // 0.7 → at risk
            makeSprint({ id: 'c', name: 'S3', committed_points: 20, completed_points: 8 }), //  0.4 → below target
          ],
        })}
      />,
    );
    const titles = Array.from(container.querySelectorAll('title')).map((t) => t.textContent);
    expect(titles[0]).toContain('(on track)');
    expect(titles[1]).toContain('(at risk)');
    expect(titles[2]).toContain('(below target)');
  });

  it('describes the chart bands via aria-describedby (WCAG 1.4.1)', () => {
    const { container } = render(
      <VelocityPanel velocity={makeVelocity({ sprints: [makeSprint({})] })} />,
    );
    const chart = container.querySelector('svg[role="img"]');
    expect(chart).toHaveAttribute('aria-describedby', 'velocity-band-legend');
    const legend = container.querySelector('#velocity-band-legend');
    expect(legend).toBeInTheDocument();
    expect(legend?.textContent).toMatch(/on track/i);
  });

  // ADR-0113: excluded sprints are marked (not dropped), the effect is surfaced
  // in plain language, and excluded bars opt out of the health palette.
  it('renders the "N excluded" callout when sprints are excluded', () => {
    render(
      <VelocityPanel
        velocity={makeVelocity({
          sprints: [
            makeSprint({ id: 'a', name: 'Sprint 0', exclude_from_velocity: true }),
            makeSprint({ id: 'b', name: 'S1' }),
          ],
          excluded_count: 1,
          rolling_avg_points: 30,
        })}
      />,
    );
    expect(screen.getByText(/1 excluded/)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/1 sprint excluded from this forecast: Sprint 0/),
    ).toBeInTheDocument();
  });

  it('omits the excluded callout when nothing is excluded', () => {
    render(
      <VelocityPanel
        velocity={makeVelocity({ sprints: [makeSprint({})], excluded_count: 0 })}
      />,
    );
    expect(screen.queryByText(/\d+ excluded/)).not.toBeInTheDocument();
  });

  it('marks an excluded bar with an "excl" label and an excluded title', () => {
    const { container } = render(
      <VelocityPanel
        velocity={makeVelocity({
          sprints: [makeSprint({ id: 'a', name: 'Sprint 0', exclude_from_velocity: true })],
          excluded_count: 1,
        })}
      />,
    );
    const titles = Array.from(container.querySelectorAll('title')).map((t) => t.textContent);
    expect(titles[0]).toContain('excluded from velocity');
    // The "excl" sub-label is the non-color marker under the bar.
    const texts = Array.from(container.querySelectorAll('text')).map((t) => t.textContent);
    expect(texts).toContain('excl');
  });

  it('counts only eligible sprints in the "(last N)" rolling-avg label', () => {
    render(
      <VelocityPanel
        velocity={makeVelocity({
          sprints: [
            makeSprint({ id: 'a', name: 'Sprint 0', exclude_from_velocity: true }),
            makeSprint({ id: 'b', name: 'S1' }),
            makeSprint({ id: 'c', name: 'S2' }),
          ],
          excluded_count: 1,
          rolling_avg_points: 30,
        })}
      />,
    );
    // 3 displayed − 1 excluded = 2 counted.
    expect(screen.getByText(/\(last 2\)/)).toBeInTheDocument();
  });
});
