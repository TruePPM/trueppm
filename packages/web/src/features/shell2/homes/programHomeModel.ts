import type { Program } from '@/api/types';
import type { Project, MonteCarloResult } from '@/types';
import { staleForecastLine } from '@/features/programs/ProgramOverview2';
import type { ProgramRollup } from '@/features/programs/ProgramOverviewPage';
import { noValueReason } from '@/features/programs/ProgramOverviewPage';
import type { ProjectHealthRow } from '@/hooks/useProjectsHealthSummary';
import { HEALTH_BAND_LABEL } from '@/lib/healthBand';
import { projectPath } from '@/lib/refPath';

/**
 * View models shared by the PM home (#4769) and the Executive home (#4771). Both
 * read one program's server facts: the rollup's `p80_completion` and the driver
 * project's saved Monte Carlo run. Every figure is the server's; this file only
 * decides which state applies and joins rows (ADR-1314).
 */

export type ForecastHeroState =
  | { kind: 'loading' }
  | { kind: 'error' }
  /** The server has no P80 for the program; `reason` is its rule-119 reason, in words. */
  | { kind: 'none'; reason: string }
  | {
      kind: 'ready';
      p80: string;
      asOf: string | null;
      /** The server's sentence for `p80_completion`, shown verbatim. */
      definition: string | undefined;
      /** The project whose forecast sets the program's P80; the S-curve is its run. */
      driverProjectId: string | null;
      projectsWithoutForecast: number;
      /** Forecasts the P80 still counts that no longer describe their project's plan. */
      projectsWithStaleForecast: number;
      /** The program overview's sentence naming them; null when none is stale. */
      staleLine: string | null;
    };

export interface RollupQuery {
  data: ProgramRollup | undefined;
  isLoading: boolean;
  error: unknown;
}

export function forecastHeroState(q: RollupQuery): ForecastHeroState {
  if (q.error) return { kind: 'error' };
  if (q.isLoading || !q.data) return { kind: 'loading' };
  // `forecast` is served whether or not the KPI is enabled; the program overview reads it too.
  const kpi = q.data.forecast ?? q.data.kpis?.p80_completion;
  if (!kpi) return { kind: 'none', reason: 'No forecast yet' };
  if (!kpi.available)
    return { kind: 'none', reason: noValueReason('no_forecast') ?? 'No forecast yet' };
  if (typeof kpi.value !== 'string' || !kpi.value) {
    return { kind: 'none', reason: noValueReason(kpi.reason) ?? 'No forecast yet' };
  }
  return {
    kind: 'ready',
    p80: kpi.value,
    asOf: kpi.as_of ?? q.data.as_of ?? null,
    definition: q.data.definitions?.p80_completion,
    driverProjectId: kpi.driver_project_id ?? null,
    projectsWithoutForecast: kpi.projects_without_forecast ?? 0,
    projectsWithStaleForecast: kpi.projects_with_stale_forecast_ids?.length ?? 0,
    staleLine: staleForecastLine({ forecast: kpi, projects: q.data.projects }),
  };
}

/** The program a home opens on: the person's choice if it still exists, else the first the server lists. */
export function chooseProgram(
  programs: ReadonlyArray<Program> | undefined,
  chosenId: string | null,
): Program | null {
  if (!programs || programs.length === 0) return null;
  return programs.find((p) => p.id === chosenId) ?? programs[0];
}

/**
 * "Biggest slip" focus card. The delta is the server's working-time measure
 * (`p80DeltaVsCommitmentDays`); a null delta carries its own reason and the card
 * says nothing rather than guessing (rule 119).
 */
export type SlipCard =
  | { kind: 'none' }
  | { kind: 'past'; days: number }
  | { kind: 'within'; days: number };

export function slipCard(
  mc: Pick<MonteCarloResult, 'p80DeltaVsCommitmentDays'> | undefined,
): SlipCard {
  const d = mc?.p80DeltaVsCommitmentDays;
  if (d === undefined || d === null) return { kind: 'none' };
  return d > 0 ? { kind: 'past', days: d } : { kind: 'within', days: Math.abs(d) };
}

export interface ProjectRow {
  id: string;
  name: string;
  to: string;
  /** The server's band word, or null when the health summary has no row for it. */
  health: string | null;
  atRisk: number | null;
  overdue: number | null;
}

/** Join the program roster with the health summary by id. Order is the server's. */
export function projectRows(
  projects: ReadonlyArray<Project> | undefined,
  health: ReadonlyArray<ProjectHealthRow> | undefined,
): ProjectRow[] {
  const bands = new Map((health ?? []).map((h) => [h.id, h.healthBand]));
  return (projects ?? []).map((p) => {
    const band = bands.get(p.id);
    return {
      id: p.id,
      name: p.name,
      to: projectPath(p),
      health: band ? HEALTH_BAND_LABEL[band] : null,
      atRisk: p.atRiskCount ?? null,
      overdue: p.overdueCount ?? null,
    };
  });
}
