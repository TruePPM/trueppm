import { screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { MultiTeamLens } from './MultiTeamLens';
import type { MyActiveSprintEntry } from '@/hooks/useMyActiveSprints';

function entry(overrides: Partial<MyActiveSprintEntry> = {}): MyActiveSprintEntry {
  return {
    project_id: overrides.project_id ?? 'proj-1',
    project_name: overrides.project_name ?? 'Alpha Platform',
    sprint: {
      id: 'sp-1',
      name: 'Telemetry sweep',
      short_id_display: 'SP-A1B2',
      start_date: '2026-04-01',
      finish_date: '2026-04-14',
      day: 7,
      total: 14,
      remaining_points: 18,
      committed_points: 40,
      trend_pts: -8,
      ...overrides.sprint,
    },
    capacity_ratio: overrides.capacity_ratio ?? 0.85,
    capacity_label: overrides.capacity_label ?? 'on_track',
    velocity: overrides.velocity ?? {
      rolling_avg_points: 38,
      forecast_range_low: 32,
      forecast_range_high: 45,
    },
  };
}

describe('MultiTeamLens', () => {
  it('renders the section heading and entry count', () => {
    renderWithRouter(
      <MultiTeamLens
        entries={[
          entry({ project_id: 'p1', project_name: 'Alpha' }),
          entry({ project_id: 'p2', project_name: 'Beta' }),
        ]}
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: /My Teams/i })).toBeInTheDocument();
    const subheading = screen.getByText(/active sprints/i);
    expect(subheading).toHaveTextContent(/2/);
  });

  it('renders one card per entry with the project name and sprint id', () => {
    renderWithRouter(
      <MultiTeamLens
        entries={[
          entry({ project_id: 'p1', project_name: 'Alpha' }),
          entry({ project_id: 'p2', project_name: 'Beta' }),
        ]}
      />,
    );
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getAllByText('SP-A1B2')).toHaveLength(2);
  });

  it('uses semantic-on-track when sprint is ahead of ideal', () => {
    renderWithRouter(
      <MultiTeamLens
        entries={[entry({ sprint: { trend_pts: 4 } as MyActiveSprintEntry['sprint'] })]}
      />,
    );
    const trend = screen.getByText(/4 pts ahead/i);
    expect(trend.className).toMatch(/text-semantic-on-track/);
  });

  it('uses semantic-at-risk when sprint is behind ideal', () => {
    renderWithRouter(
      <MultiTeamLens
        entries={[entry({ sprint: { trend_pts: -6 } as MyActiveSprintEntry['sprint'] })]}
      />,
    );
    const trend = screen.getByText(/6 pts behind/i);
    expect(trend.className).toMatch(/text-semantic-at-risk/);
  });

  it('colours capacity by label band', () => {
    renderWithRouter(
      <MultiTeamLens entries={[entry({ capacity_label: 'over_capacity' })]} />,
    );
    const capacity = screen.getByText('85%');
    expect(capacity.className).toMatch(/text-semantic-critical/);
  });

  it('renders an empty-state status when no entries are returned', () => {
    renderWithRouter(<MultiTeamLens entries={[]} />);
    expect(
      screen.getByText(/No active assignments across your teams/i),
    ).toBeInTheDocument();
  });

  it('cards link to the project Sprints view', () => {
    renderWithRouter(
      <MultiTeamLens entries={[entry({ project_id: 'proj-xyz', project_name: 'Gamma' })]} />,
    );
    const link = screen.getByRole('link', { name: /Gamma/i });
    expect(link).toHaveAttribute('href', '/projects/proj-xyz/sprints');
  });

  it('falls back to "no velocity yet" when forecast bounds are null', () => {
    renderWithRouter(
      <MultiTeamLens
        entries={[
          entry({
            velocity: {
              rolling_avg_points: null,
              forecast_range_low: null,
              forecast_range_high: null,
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText(/no velocity yet/i)).toBeInTheDocument();
  });
});
