import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Band, partialRollupLine } from './ProgramOverview2';
import { buildAxis } from './programAxis';
import type { ProgramRollupRow } from './ProgramOverviewPage';

const row = (id: string, name: string): ProgramRollupRow => ({
  id,
  name,
  accessible: true,
  schedule_health: 'on_track',
  p50: null,
  p80: null,
  forecast_as_of: null,
  commitment_date: null,
  p80_delta_vs_commitment_days: null,
  p80_delta_vs_commitment_reason: null,
  lead_name: null,
  latest_update: null,
});

describe('partialRollupLine', () => {
  const projects = [row('a', 'Alpha'), row('b', 'Identity Consolidation'), row('c', 'Gamma')];

  it('names the project the program P80 leaves out', () => {
    expect(
      partialRollupLine({
        projects,
        forecast: { available: true, value: '2027-01-01', projects_without_forecast_ids: ['b'] },
      }),
    ).toBe(
      '1 of 3 projects didn’t report (Identity Consolidation); the program P80 excludes it until it reports.',
    );
  });

  it('is null when every project reported', () => {
    expect(
      partialRollupLine({
        projects,
        forecast: { available: true, value: null, projects_without_forecast_ids: [] },
      }),
    ).toBeNull();
  });

  it('falls back to a count when an id has no row', () => {
    expect(
      partialRollupLine({
        projects,
        forecast: { available: true, value: null, projects_without_forecast_ids: ['b', 'zz'] },
      }),
    ).toContain('(2 projects)');
  });
});

describe('Band edge markers', () => {
  const far = { ...row('f', 'Far'), p50: '2027-01-01', p80: '2027-02-01' };
  const outlier = { ...far, id: 'o', commitment_date: '2031-01-01' };

  it('marks a commitment past the axis with an edge marker and says so', () => {
    const axis = buildAxis([far, outlier], 120)!;
    render(<Band axis={axis} row={outlier} />);
    expect(screen.getByTestId('program-row-clamp-commitment')).toBeInTheDocument();
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      'commitment beyond the axis',
    );
  });

  it('draws no marker when everything is on the axis', () => {
    const axis = buildAxis([far], 120)!;
    render(<Band axis={axis} row={far} />);
    expect(screen.queryByTestId('program-row-clamp-commitment')).toBeNull();
  });
});
