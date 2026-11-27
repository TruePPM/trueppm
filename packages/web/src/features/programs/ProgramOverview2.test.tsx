import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Band,
  budgetBurnMissing,
  overAllocatedFigure,
  partialRollupLine,
  staleForecastLine,
} from './ProgramOverview2';
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

describe('staleForecastLine (#2408)', () => {
  const projects = [row('a', 'Alpha'), row('b', 'Beta')];

  it('names the stale forecast the program P80 still counts', () => {
    expect(
      staleForecastLine({
        projects,
        forecast: { available: true, value: '2027-01-01', projects_with_stale_forecast_ids: ['b'] },
      }),
    ).toBe('1 forecast is out of date (Beta); the program P80 still counts it until it is rerun.');
  });

  it('pluralizes and falls back to a count when an id has no row', () => {
    expect(
      staleForecastLine({
        projects,
        forecast: {
          available: true,
          value: '2027-01-01',
          projects_with_stale_forecast_ids: ['a', 'zz'],
        },
      }),
    ).toBe(
      '2 forecasts are out of date (2 projects); the program P80 still counts them until they are rerun.',
    );
  });

  it('is null when no forecast is stale, or from a server that does not send the field', () => {
    expect(
      staleForecastLine({
        projects,
        forecast: { available: true, value: '2027-01-01', projects_with_stale_forecast_ids: [] },
      }),
    ).toBeNull();
    expect(
      staleForecastLine({ projects, forecast: { available: true, value: '2027-01-01' } }),
    ).toBeNull();
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

  it('says so when the P50 starts before the axis', () => {
    const axis = buildAxis([far], 120)!;
    const early = { ...far, id: 'e', p50: '2020-01-01' };
    render(<Band axis={axis} row={early} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('P50 before the axis');
  });

  it('draws no marker when everything is on the axis', () => {
    const axis = buildAxis([far], 120)!;
    render(<Band axis={axis} row={far} />);
    expect(screen.queryByTestId('program-row-clamp-commitment')).toBeNull();
  });
});

describe('budgetBurnMissing', () => {
  const projects = [row('a', 'Alpha'), row('b', 'Identity Consolidation')];
  const kpis = (entry: unknown) => ({ budget_utilization: entry }) as never;

  it('names the one project without a budget baseline', () => {
    expect(
      budgetBurnMissing({
        projects,
        kpis: kpis({
          available: false,
          reason: 'no_budget',
          projects_without_budget: 1,
          projects_without_budget_ids: ['b'],
        }),
      }),
    ).toBe('Identity Consolidation has no budget baseline');
  });

  it('falls back to a count when it cannot name them', () => {
    expect(
      budgetBurnMissing({
        projects,
        kpis: kpis({ available: false, reason: 'no_budget', projects_without_budget: 2 }),
      }),
    ).toBe('2 projects have no budget baseline');
  });

  it('names missing rates, not a project, when logged time has no cost rate', () => {
    expect(
      budgetBurnMissing({
        projects,
        kpis: kpis({ available: false, reason: 'missing_rates', missing_rate_count: 3 }),
      }),
    ).toBe('some logged time has no cost rate');
  });

  it('says nothing when restricted, computed, or not configured', () => {
    expect(
      budgetBurnMissing({ projects, kpis: kpis({ available: false, reason: 'cost_restricted' }) }),
    ).toBeNull();
    expect(budgetBurnMissing({ projects, kpis: kpis({ available: true, value: 0.4 }) })).toBeNull();
    expect(budgetBurnMissing({ projects, kpis: {} })).toBeNull();
  });
});

describe('overAllocatedFigure', () => {
  const scope = {
    project_count: 2,
    withheld_project_count: 1,
    capacity_withheld_project_count: 0,
    program_id: 'p',
  };

  it('states the count and how many projects it leaves out', () => {
    expect(overAllocatedFigure({ over_allocated_count: 3, reason: null, scope }, false)).toEqual({
      kind: 'value',
      count: 3,
      sub: 'people over 100% in 2 projects you can schedule; 1 project withheld',
    });
  });

  it('keeps a real zero a zero, with no withheld clause when nothing is withheld', () => {
    expect(
      overAllocatedFigure(
        {
          over_allocated_count: 0,
          reason: 'no_people',
          scope: { ...scope, project_count: 1, withheld_project_count: 0 },
        },
        false,
      ),
    ).toEqual({ kind: 'value', count: 0, sub: 'people over 100% in 1 project you can schedule' });
  });

  it('is not computable, never zero, when no project is in scope or all are withheld', () => {
    const none = overAllocatedFigure(
      { over_allocated_count: 0, reason: 'no_projects', scope },
      false,
    );
    expect(none.kind).toBe('missing');
    const withheld = overAllocatedFigure(
      { over_allocated_count: 0, reason: 'all_withheld', scope },
      false,
    );
    expect(withheld).toEqual({
      kind: 'missing',
      missing: 'the teams have not shared their capacity with your role',
    });
  });

  it('is not computable on an error or a malformed payload', () => {
    expect(overAllocatedFigure(undefined, true).kind).toBe('missing');
    expect(overAllocatedFigure({ count: 0 } as never, false).kind).toBe('missing');
  });
});
