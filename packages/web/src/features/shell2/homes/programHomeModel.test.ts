import { describe, expect, it } from 'vitest';
import type { Program } from '@/api/types';
import type { Project } from '@/types';
import type { ProgramRollup } from '@/features/programs/ProgramOverviewPage';
import { chooseProgram, forecastHeroState, projectRows, slipCard } from './programHomeModel';

const rollup = (kpi: unknown, extra: Partial<ProgramRollup> = {}): ProgramRollup =>
  ({
    aggregation_policy: 'worst',
    policy_available: true,
    project_count: 2,
    program_health: 'on_track',
    kpis: { p80_completion: kpi },
    ...extra,
  }) as ProgramRollup;

describe('forecastHeroState', () => {
  it('error wins over a stale payload; loading while no data', () => {
    expect(
      forecastHeroState({ data: undefined, isLoading: false, error: new Error('x') }).kind,
    ).toBe('error');
    expect(forecastHeroState({ data: undefined, isLoading: true, error: null }).kind).toBe(
      'loading',
    );
  });
  it('ready carries the server date, as_of, driver and definition verbatim', () => {
    const s = forecastHeroState({
      data: rollup(
        {
          available: true,
          value: '2026-12-07',
          as_of: '2026-11-20T09:12:00Z',
          driver_project_id: 'p-1',
          projects_without_forecast: 1,
        },
        { definitions: { p80_completion: 'The server sentence.' } },
      ),
      isLoading: false,
      error: null,
    });
    expect(s).toEqual({
      kind: 'ready',
      p80: '2026-12-07',
      asOf: '2026-11-20T09:12:00Z',
      definition: 'The server sentence.',
      driverProjectId: 'p-1',
      projectsWithoutForecast: 1,
      projectsWithStaleForecast: 0,
      staleLine: null,
    });
  });
  it('carries the stale forecasts the P80 still counts, by name (#2408)', () => {
    const s = forecastHeroState({
      data: rollup(
        { available: true, value: '2026-12-07', projects_with_stale_forecast_ids: ['p-1'] },
        { projects: [{ id: 'p-1', name: 'Atlas' }] as ProgramRollup['projects'] },
      ),
      isLoading: false,
      error: null,
    });
    expect(s).toMatchObject({
      projectsWithStaleForecast: 1,
      staleLine:
        '1 forecast is out of date (Atlas); the program P80 still counts it until it is rerun.',
    });
  });
  it('reads `forecast` when the p80_completion KPI is disabled', () => {
    const s = forecastHeroState({
      data: {
        ...rollup(undefined, {
          forecast: { available: true, value: '2026-12-07', driver_project_id: 'p-2' },
        }),
        kpis: {},
      } as ProgramRollup,
      isLoading: false,
      error: null,
    });
    expect(s).toMatchObject({ kind: 'ready', p80: '2026-12-07', driverProjectId: 'p-2' });
  });
  it('a null value carries its reason; an unavailable kpi says no forecast', () => {
    const none = forecastHeroState({
      data: rollup({ available: true, value: null, reason: 'no_forecast' }),
      isLoading: false,
      error: null,
    });
    expect(none).toEqual({ kind: 'none', reason: 'No project has a forecast yet' });
    expect(
      forecastHeroState({
        data: rollup({ available: false, reason: 'no_montecarlo_store' }),
        isLoading: false,
        error: null,
      }).kind,
    ).toBe('none');
    expect(
      forecastHeroState({ data: { ...rollup(undefined), kpis: {} }, isLoading: false, error: null })
        .kind,
    ).toBe('none');
  });
});

describe('chooseProgram', () => {
  const ps = [{ id: 'a' }, { id: 'b' }] as Program[];
  it('honors a choice that still exists, else the first listed, else null', () => {
    expect(chooseProgram(ps, 'b')?.id).toBe('b');
    expect(chooseProgram(ps, 'gone')?.id).toBe('a');
    expect(chooseProgram(ps, null)?.id).toBe('a');
    expect(chooseProgram([], null)).toBeNull();
    expect(chooseProgram(undefined, null)).toBeNull();
  });
});

describe('slipCard', () => {
  it('reads the server delta; a null delta says nothing', () => {
    expect(slipCard({ p80DeltaVsCommitmentDays: 2 })).toEqual({ kind: 'past', days: 2 });
    expect(slipCard({ p80DeltaVsCommitmentDays: -3 })).toEqual({ kind: 'within', days: 3 });
    expect(slipCard({ p80DeltaVsCommitmentDays: 0 })).toEqual({ kind: 'within', days: 0 });
    expect(slipCard({ p80DeltaVsCommitmentDays: null })).toEqual({ kind: 'none' });
    expect(slipCard(undefined)).toEqual({ kind: 'none' });
  });
});

describe('projectRows', () => {
  it('joins health by id, keeps server order, and leaves a missing band null', () => {
    const projects = [
      { id: '1', name: 'Atlas', atRiskCount: 2, overdueCount: 0 },
      { id: '2', name: 'Ledger' },
    ] as Project[];
    const rows = projectRows(projects, [
      {
        id: '1',
        name: 'Atlas',
        healthBand: 'at_risk',
        healthBandSource: 'derived',
        atRiskCount: 2,
        criticalCount: 0,
      },
    ]);
    expect(rows.map((r) => [r.name, r.health, r.atRisk, r.overdue])).toEqual([
      ['Atlas', 'At risk', 2, 0],
      ['Ledger', null, null, null],
    ]);
    expect(projectRows(undefined, undefined)).toEqual([]);
  });
});
