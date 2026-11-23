import { describe, expect, it } from 'vitest';
import { partialRollupLine } from './ProgramOverview2';
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
      '1 of 3 projects didn’t report (Identity Consolidation); the program P80 excludes it until it returns.',
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
