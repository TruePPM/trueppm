import { Link } from 'react-router';
import { Avatar } from '@/components/page2/Avatar';
import { DefinitionTip } from '@/components/page2/DefinitionTip';
import { NotComputable } from '@/components/page2/NotComputable';
import { PageFrame } from '@/components/page2/PageFrame';
import { PageTitle, SectionHeading } from '@/components/page2/PageTitle';
import { HealthBandChip, StatusChip } from '@/components/page2/StatusChip';
import { TYPE } from '@/components/page2/typeScale';
import { QueryErrorState } from '@/components/QueryErrorState';
import { commitmentChip } from '@/features/project/ProjectOverview2';
import { CallChip } from '@/features/project/statusUpdates/StatusUpdatesSection';
import { useMinWidth } from '@/features/shell2/useMinWidth';
import { useProgram } from '@/hooks/useProgram';
import { usePeopleLoad, PEOPLE_LOAD_WEEKS } from '@/hooks/usePeopleLoad';
import type { PeopleLoadResponse } from '@/api/types';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { fmtUtcLong, fmtUtcMedium } from '@/lib/formatUtcDate';
import { asHealthBand } from '@/lib/ragBand';
import { ROLE_OWNER } from '@/lib/roles';
import { useProgramMembers } from './hooks/useProgramMembers';
import { axisPosition, buildAxis, type Axis } from './programAxis';
import {
  HEALTH_LABEL,
  noValueReason,
  useProgramRollup,
  type ProgramRollup,
  type ProgramRollupRow,
} from './ProgramOverviewPage';
import { SampleDataBanner } from './SampleDataBanner';

const CARD = 'rounded-lg border border-p1-hairline bg-p1-surface-1 p-4';

/**
 * The partial-rollup line (#4799): which projects did not report, by name, and that
 * the program P80 leaves them out. Names come from the rows; the ids are the
 * server's (`forecast.projects_without_forecast_ids`). Null when every project has
 * a forecast.
 */
export function partialRollupLine(
  rollup: Pick<ProgramRollup, 'forecast' | 'projects'>,
): string | null {
  const ids = rollup.forecast?.projects_without_forecast_ids ?? [];
  const rows = rollup.projects ?? [];
  if (ids.length === 0 || rows.length === 0) return null;
  const names = ids.map((id) => rows.find((r) => r.id === id)?.name).filter(Boolean) as string[];
  const subject = names.length === ids.length ? names.join(', ') : `${ids.length} projects`;
  const pronoun = ids.length === 1 ? 'it' : 'them';
  return `${ids.length} of ${rows.length} projects didn’t report (${subject}); the program P80 excludes ${pronoun} until ${ids.length === 1 ? 'it reports' : 'they report'}.`;
}

/**
 * Why the program's budget burn has no value, as the clause the NotComputable line
 * completes (#4799). Null when the KPI is not configured, has a value, or is hidden
 * from this caller (`cost_restricted` discloses nothing, ADR-1324 §4). Names come
 * from the rows; the ids are the server's.
 */
export function budgetBurnMissing(rollup: Pick<ProgramRollup, 'kpis' | 'projects'>): string | null {
  const kpi = rollup.kpis?.budget_utilization;
  if (!kpi || kpi.available) return null;
  if (kpi.reason === 'missing_rates') return 'some logged time has no cost rate';
  if (kpi.reason !== 'no_budget') return null;
  const ids = kpi.projects_without_budget_ids ?? [];
  const names = ids
    .map((id) => (rollup.projects ?? []).find((r) => r.id === id)?.name)
    .filter(Boolean) as string[];
  if (ids.length === 1 && names.length === 1) return `${names[0]} has no budget baseline`;
  const n = kpi.projects_without_budget ?? ids.length;
  return n === 1 ? 'a project has no budget baseline' : `${n} projects have no budget baseline`;
}

/**
 * The Over-allocated figure for the program (#4799), from the server's `over_allocated_count`
 * on `/me/people-load/?program=`. That count is scoped to the projects the caller may read
 * per-person load on, so the line says how many it leaves out. A figure is withheld
 * (not zero) when no project is in scope, and an error or a malformed payload is the
 * not-computable line, never a 0.
 */
export type OverAllocated =
  | { kind: 'value'; count: number; sub: string }
  | { kind: 'missing'; missing: string };

export function overAllocatedFigure(
  data: Pick<PeopleLoadResponse, 'over_allocated_count' | 'reason' | 'scope'> | undefined,
  failed: boolean,
): OverAllocated {
  if (failed || !data || typeof data.over_allocated_count !== 'number') {
    return { kind: 'missing', missing: 'the load figure did not load' };
  }
  if (data.reason === 'no_projects') {
    return {
      kind: 'missing',
      missing: 'you do not hold a Scheduler role on any project in this program',
    };
  }
  if (data.reason === 'all_withheld') {
    return {
      kind: 'missing',
      missing: 'the teams have not shared their capacity with your role',
    };
  }
  const withheld = data.scope?.withheld_project_count ?? 0;
  const counted = data.scope?.project_count ?? 0;
  const base = `people over 100% in ${counted} ${counted === 1 ? 'project' : 'projects'} you can schedule`;
  return {
    kind: 'value',
    count: data.over_allocated_count,
    sub:
      withheld > 0
        ? `${base}; ${withheld} ${withheld === 1 ? 'project' : 'projects'} withheld`
        : base,
  };
}

function ProgramTile({
  term,
  definition,
  asOf,
  value,
  sub,
  to,
}: {
  term: string;
  definition?: string;
  asOf?: string;
  value: string;
  sub?: string;
  to?: string;
}) {
  return (
    <div className={CARD} data-testid="program-overview2-tile">
      <div className="text-xs text-p1-text-2">
        <DefinitionTip term={term} definition={definition} asOf={asOf} />
      </div>
      <div className={`${TYPE.tile} mt-1 text-p1-text-1`}>{value}</div>
      {sub && <div className="text-xs text-p1-text-2">{sub}</div>}
      {to && (
        <Link className="text-xs text-p1-brand underline" to={to}>
          View
        </Link>
      )}
    </div>
  );
}

export function Band({ axis, row }: { axis: Axis; row: ProgramRollupRow }) {
  if (!row.p80) {
    return <span className="text-xs text-p1-text-2">No forecast</span>;
  }
  const p80 = axisPosition(axis, row.p80);
  const p50 = row.p50 ? axisPosition(axis, row.p50) : p80;
  const commit = row.commitment_date ? axisPosition(axis, row.commitment_date) : null;
  const clampedEnd = p80.clamped === 'end';
  const clampedStart = p50.clamped === 'start';
  const commitClamp = commit?.clamped ?? null;
  const label = `P50 ${row.p50 ? fmtUtcMedium(row.p50) : 'not computed'} to P80 ${fmtUtcMedium(row.p80)}${
    row.commitment_date ? `, commitment ${fmtUtcMedium(row.commitment_date)}` : ''
  }${clampedStart ? ', P50 before the axis' : ''}${clampedEnd ? ', P80 beyond the axis' : ''}${commitClamp ? ', commitment beyond the axis' : ''}`;
  return (
    <div
      role="img"
      aria-label={label}
      className="relative h-6 w-full min-w-[120px]"
      data-testid="program-row-band"
    >
      <div className="absolute inset-x-0 top-1/2 h-px bg-p1-hairline" />
      <div
        className="absolute top-1/2 h-2 -translate-y-1/2 rounded-sm bg-p1-text-3"
        style={{ left: `${p50.pct}%`, width: `${Math.max(0.5, p80.pct - p50.pct)}%` }}
      />
      <div
        className="absolute top-0 h-6 w-0.5 bg-p1-text-1"
        style={{ left: `calc(${p80.pct}% - 1px)` }}
        data-testid="program-row-p80-tick"
      />
      {commit && (
        <div
          className="absolute top-0 h-6 border-l border-dashed border-p1-text-2"
          style={{ left: `${commit.pct}%` }}
          data-testid="program-row-commitment"
        />
      )}
      {clampedEnd && (
        <span
          aria-hidden="true"
          className="absolute -right-1 top-1/2 -translate-y-1/2 text-xs text-p1-text-1"
          data-testid="program-row-clamp-end"
        >
          ▸
        </span>
      )}
      {commitClamp && !(commitClamp === 'end' ? clampedEnd : clampedStart) && (
        <span
          aria-hidden="true"
          className={`absolute ${commitClamp === 'end' ? '-right-1' : '-left-1'} top-1/2 -translate-y-1/2 text-xs text-p1-text-2`}
          data-testid="program-row-clamp-commitment"
        >
          {commitClamp === 'end' ? '▸' : '◂'}
        </span>
      )}
      {clampedStart && (
        <span
          aria-hidden="true"
          className="absolute -left-1 top-1/2 -translate-y-1/2 text-xs text-p1-text-1"
          data-testid="program-row-clamp-start"
        >
          ◂
        </span>
      )}
    </div>
  );
}

function Narrative({ row }: { row: ProgramRollupRow }) {
  const { formatInstantDate } = useUserDateFormat();
  const u = row.latest_update;
  if (!u) {
    return <p className="truncate text-xs text-p1-text-2">No status update posted yet.</p>;
  }
  const computed = asHealthBand(u.computed_health);
  return (
    <p className="truncate text-xs text-p1-text-2" data-testid="program-row-narrative">
      {computed && <span>computed {HEALTH_LABEL[computed].toLowerCase()} · </span>}
      <span className="text-p1-text-1">{u.first_line || `Update ${u.seq}`}</span>
      <span>
        {' '}
        · {u.author_name ?? 'Former member'}, {formatInstantDate(u.posted_at, 'medium')}
      </span>
    </p>
  );
}

function RowChip({ row }: { row: ProgramRollupRow }) {
  if (row.latest_update) return <CallChip rag={row.latest_update.rag} />;
  const band = asHealthBand(row.schedule_health);
  return band ? <HealthBandChip band={band} /> : <StatusChip tone="neutral" label="Unknown" />;
}

function ProjectRow({
  axis,
  row,
  wide,
}: {
  axis: Axis | null;
  row: ProgramRollupRow;
  wide: boolean;
}) {
  if (!row.accessible) {
    return (
      <li
        className="flex min-h-[64px] items-center gap-3 px-3 py-2 text-sm"
        data-testid="program-row"
      >
        <span className="font-medium text-p1-text-1">{row.name}</span>
        <span className="text-xs text-p1-text-2">You’re not a member of this project.</span>
      </li>
    );
  }
  const chip = commitmentChip(row.p80_delta_vs_commitment_days);
  return (
    <li
      className={
        wide
          ? 'grid min-h-[64px] grid-cols-[minmax(0,2fr)_minmax(120px,2fr)_auto_auto_auto] items-center gap-4 px-3 py-2'
          : 'flex flex-col gap-2 p-3'
      }
      data-testid="program-row"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <RowChip row={row} />
          <Link
            to={`/projects/${row.id}/overview`}
            className="truncate text-sm font-medium text-p1-text-1 underline"
          >
            {row.name}
          </Link>
        </div>
        <Narrative row={row} />
      </div>
      {axis ? (
        <Band axis={axis} row={row} />
      ) : (
        <span className="text-xs text-p1-text-2">No forecast</span>
      )}
      <span className="font-mono text-sm tabular-nums text-p1-text-1">
        {row.p80 ? fmtUtcMedium(row.p80) : '—'}
      </span>
      {chip ? (
        <StatusChip tone={chip.tone} label={chip.label} />
      ) : (
        <span className="text-xs text-p1-text-3">No commitment</span>
      )}
      {row.lead_name ? (
        <Avatar name={row.lead_name} />
      ) : (
        <span className="text-xs text-p1-text-3">No lead</span>
      )}
    </li>
  );
}

/**
 * Shell v2 Program Overview (#4799): one lead figure (the program P80, named by the
 * project that sets it), the program's own figures, then one row per project on a
 * shared axis, sorted by slip. Every figure is the server's (`/rollup/`); this
 * component lays them out and computes none. One program, no cross-program scope.
 */
export function ProgramOverview2({ programId }: { programId: string }) {
  const { data: rollup, isLoading, error, refetch } = useProgramRollup(programId);
  const load = usePeopleLoad(PEOPLE_LOAD_WEEKS, programId);
  const { formatInstant } = useUserDateFormat();
  const wide = useMinWidth(768);

  const rows = rollup?.projects ?? [];
  // The tiles count only projects the caller belongs to. Zero in scope with named rows is
  // "unknown", not zero; a partial scope undercounts, so the sub-lines say so.
  const inScope = rollup?.summary?.projects_in_scope_count ?? 0;
  const inScopeNone = inScope === 0 && rows.length > 0;
  const uncounted = Math.max(0, rows.length - inScope);
  const notCounted =
    !inScopeNone && uncounted > 0
      ? `; ${uncounted} ${uncounted === 1 ? 'project' : 'projects'} not counted`
      : '';
  const axis = buildAxis(rows.filter((r) => r.accessible));
  const forecast = rollup?.forecast;
  const p80 = typeof forecast?.value === 'string' ? forecast.value : null;
  const driver = rows.find((r) => r.id === forecast?.driver_project_id);
  const partial = rollup ? partialRollupLine(rollup) : null;
  const budgetMissing = rollup ? budgetBurnMissing(rollup) : null;
  // Nothing while the load query is in flight: a not-computable line that flashes and
  // then becomes a tile reads as the figure changing its mind.
  const overAllocated =
    load.isLoading || (load.isFetching && !load.data && !load.error)
      ? null
      : overAllocatedFigure(load.data, Boolean(load.error));

  // Same states as V1 (#3875): stale, anchor-unknown, and the owner-name line for
  // non-owners, who cannot shift or remove a sample.
  const { data: program } = useProgram(programId);
  const sampleNeedsOwner = !!program?.is_sample && program.my_role !== ROLE_OWNER;
  const { data: sampleMembers } = useProgramMembers(sampleNeedsOwner ? programId : undefined);
  const ownerNames = (sampleMembers ?? [])
    .filter((m) => m.role === ROLE_OWNER)
    .map((m) => m.user_detail.username);

  return (
    <PageFrame width="contained" header={<PageTitle visuallyHidden>Overview</PageTitle>}>
      <div className="flex flex-col gap-6 py-4" data-testid="program-overview2">
        {program?.is_sample && (
          <SampleDataBanner
            programId={programId}
            canRemove={program.my_role === ROLE_OWNER}
            sampleDaysStale={program.sample_days_stale}
            ownerNames={ownerNames}
          />
        )}
        {error ? (
          <QueryErrorState
            variant="inline"
            message="Couldn't load the program rollup."
            onRetry={() => void refetch()}
          />
        ) : isLoading || !rollup ? (
          <div
            className={`${CARD} h-64 animate-pulse`}
            role="status"
            aria-label="Loading program overview"
            data-testid="program-overview2-skeleton"
          />
        ) : rollup.project_count === 0 ? (
          <div className={CARD} data-testid="program-overview2-empty">
            <p className={`${TYPE.section} text-p1-text-1`}>No projects in this program</p>
            <Link
              className="text-xs text-p1-brand underline"
              to={`/programs/${programId}/projects`}
            >
              Add a project
            </Link>
          </div>
        ) : (
          <>
            <section
              aria-labelledby="pov2-lead-h"
              className={CARD}
              data-testid="program-overview2-lead"
            >
              <h2 id="pov2-lead-h" className="text-xs text-p1-text-2">
                <DefinitionTip
                  term="Program finish · P80"
                  definition={rollup.definitions?.p80_completion}
                  asOf={forecast?.as_of ?? undefined}
                />
              </h2>
              {p80 ? (
                <p className={`${TYPE.lead} text-p1-text-1`} data-testid="program-overview2-p80">
                  <span className="sr-only">
                    Program finish P80, {fmtUtcLong(p80)}
                    {forecast?.as_of ? `, as of ${formatInstant(forecast.as_of)}` : ''}
                  </span>
                  <span aria-hidden="true">{fmtUtcMedium(p80)}</span>
                </p>
              ) : (
                <p className="text-sm text-p1-text-2">
                  {noValueReason(forecast?.reason) ?? 'No forecast yet'}
                </p>
              )}
              {driver && <p className="text-xs text-p1-text-2">Set by {driver.name}</p>}
              {partial && (
                <p
                  className="mt-2 text-xs text-p1-risk-text"
                  data-testid="program-overview2-partial"
                >
                  <span aria-hidden="true">◆ </span>
                  {partial}
                </p>
              )}
            </section>

            <div
              className="flex flex-wrap items-center gap-3"
              data-testid="program-overview2-health"
            >
              <span className="text-xs text-p1-text-2">
                <DefinitionTip
                  term="Program health"
                  definition={rollup.definitions?.program_health}
                  asOf={rollup.as_of}
                />
              </span>
              {asHealthBand(rollup.program_health) ? (
                <HealthBandChip band={asHealthBand(rollup.program_health)!} />
              ) : (
                <span className="text-xs text-p1-text-2">
                  {noValueReason(rollup.program_health_reason ?? undefined) ?? HEALTH_LABEL.unknown}
                </span>
              )}
            </div>

            {rollup.summary && (
              <section
                aria-label="Program figures"
                className="flex flex-col gap-3"
                data-testid="program-overview2-tiles"
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {inScopeNone ? null : (
                    <>
                      <ProgramTile
                        term="Projects on track"
                        definition={rollup.definitions?.projects_on_track}
                        asOf={rollup.as_of}
                        value={`${rollup.summary.projects_on_track} of ${rollup.summary.projects_in_scope_count}`}
                        sub={`by schedule health, in projects you belong to${notCounted}`}
                      />
                      <ProgramTile
                        term="Cross-project links"
                        definition={rollup.definitions?.cross_project_link_count}
                        asOf={rollup.as_of}
                        value={String(rollup.summary.cross_project_link_count)}
                        sub={`accepted dependencies between projects${notCounted}`}
                        to={`/programs/${programId}/schedule`}
                      />
                      <ProgramTile
                        term="Open risks"
                        definition={rollup.definitions?.open_risk_count}
                        asOf={rollup.as_of}
                        value={String(rollup.summary.open_risk_count)}
                        sub={`open or mitigating${notCounted}`}
                      />
                    </>
                  )}
                  {overAllocated?.kind === 'value' && (
                    <ProgramTile
                      term="Over-allocated"
                      definition={load.data?.definitions?.over_allocated_count}
                      asOf={load.data?.as_of}
                      value={String(overAllocated.count)}
                      sub={overAllocated.sub}
                      to={`/programs/${programId}/resources`}
                    />
                  )}
                </div>
                {inScopeNone && (
                  <NotComputable
                    label="Projects on track, cross-project links and open risks"
                    missing="you are not a member of any project in this program"
                    fix={
                      <Link
                        className="text-p1-brand underline"
                        to={`/programs/${programId}/projects`}
                      >
                        Open projects
                      </Link>
                    }
                  />
                )}
                {overAllocated?.kind === 'missing' && (
                  <NotComputable
                    label="Over-allocated"
                    missing={overAllocated.missing}
                    fix={
                      <Link
                        className="text-p1-brand underline"
                        to={`/programs/${programId}/resources`}
                      >
                        Open program resources
                      </Link>
                    }
                  />
                )}
                {budgetMissing && (
                  <NotComputable
                    label="Program budget burn"
                    missing={budgetMissing}
                    fix={
                      <Link
                        className="text-p1-brand underline"
                        to={`/programs/${programId}/projects`}
                      >
                        Open projects
                      </Link>
                    }
                  />
                )}
              </section>
            )}

            <section aria-labelledby="pov2-rows-h" className="flex flex-col gap-2">
              <SectionHeading id="pov2-rows-h">Projects</SectionHeading>
              <ul className="flex flex-col divide-y divide-p1-hairline rounded-lg border border-p1-hairline bg-p1-surface-1">
                {rows.map((row) => (
                  <ProjectRow key={row.id} axis={axis} row={row} wide={wide} />
                ))}
              </ul>
              <p className="text-xs text-p1-text-3">
                Sorted by slip. Bands run from P50 to P80 on one axis; the dashed line is the
                commitment.
              </p>
            </section>
          </>
        )}
      </div>
    </PageFrame>
  );
}
