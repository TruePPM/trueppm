import { Link } from 'react-router';
import { Avatar } from '@/components/page2/Avatar';
import { DefinitionTip } from '@/components/page2/DefinitionTip';
import { PageFrame } from '@/components/page2/PageFrame';
import { PageTitle, SectionHeading } from '@/components/page2/PageTitle';
import { HealthBandChip, StatusChip } from '@/components/page2/StatusChip';
import { TYPE } from '@/components/page2/typeScale';
import { QueryErrorState } from '@/components/QueryErrorState';
import { commitmentChip } from '@/features/project/ProjectOverview2';
import { CallChip } from '@/features/project/statusUpdates/StatusUpdatesSection';
import { useMinWidth } from '@/features/shell2/useMinWidth';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { fmtUtcLong, fmtUtcMedium } from '@/lib/formatUtcDate';
import { asHealthBand } from '@/lib/ragBand';
import { axisPosition, buildAxis, type Axis } from './programAxis';
import {
  HEALTH_LABEL,
  noValueReason,
  useProgramRollup,
  type ProgramRollup,
  type ProgramRollupRow,
} from './ProgramOverviewPage';

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
  }${clampedEnd ? ', P80 beyond the axis' : ''}${commitClamp ? ', commitment beyond the axis' : ''}`;
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
 * `title` is the program's name when the page is embedded outside the program's
 * own context header (the exec home), so the page still has a visible heading.
 */
export function ProgramOverview2({ programId, title }: { programId: string; title?: string }) {
  const { data: rollup, isLoading, error, refetch } = useProgramRollup(programId);
  const { formatInstant } = useUserDateFormat();
  const wide = useMinWidth(768);

  const rows = rollup?.projects ?? [];
  const axis = buildAxis(rows.filter((r) => r.accessible));
  const forecast = rollup?.forecast;
  const p80 = typeof forecast?.value === 'string' ? forecast.value : null;
  const driver = rows.find((r) => r.id === forecast?.driver_project_id);
  const partial = rollup ? partialRollupLine(rollup) : null;

  return (
    <PageFrame
      width="contained"
      header={
        title ? <PageTitle>{title}</PageTitle> : <PageTitle visuallyHidden>Overview</PageTitle>
      }
    >
      <div className="flex flex-col gap-6 py-4" data-testid="program-overview2">
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
