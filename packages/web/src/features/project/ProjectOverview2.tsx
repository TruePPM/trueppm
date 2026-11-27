import { Link } from 'react-router';
import { apiClient } from '@/api/client';
import { useQuery } from '@tanstack/react-query';
import { QueryErrorState } from '@/components/QueryErrorState';
import { DefinitionTip } from '@/components/page2/DefinitionTip';
import { NotComputable } from '@/components/page2/NotComputable';
import { PageFrame } from '@/components/page2/PageFrame';
import { PageTitle, SectionHeading } from '@/components/page2/PageTitle';
import { StatusChip, type StatusTone } from '@/components/page2/StatusChip';
import { TYPE } from '@/components/page2/typeScale';
import { SCurveChart, forecastToSCurveProps } from '@/features/charts';
import { useEffect, useState } from 'react';
import type { SnapshotRow } from '@/components/page2/SnapshotPanel';
import { StatusUpdatesSection } from '@/features/project/statusUpdates/StatusUpdatesSection';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useProject } from '@/hooks/useProject';
import { useMonteCarloHistory } from '@/hooks/useMonteCarloHistory';
import { ROLE_ADMIN } from '@/lib/roles';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useShellStats } from '@/hooks/useShellStats';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { fmtUtcLong, fmtUtcMedium } from '@/lib/formatUtcDate';
import type { MetricDefinitions, MonteCarloResult } from '@/types';

/** The slice of `GET /projects/:id/overview/` this page reads. Every figure is the server's. */
export interface Overview2Data {
  critical_task_count: number;
  total_tasks: number;
  complete_tasks: number;
  /** Leaf tasks with a planned duration above zero (#5103). */
  tasks_with_duration_count?: number;
  open_risk_count?: number;
  high_risk_count?: number;
  next_milestone: {
    id: string;
    name: string;
    date: string;
    percent_complete: number;
    /** The milestone's active-baseline finish, or null (#5103). */
    baseline_date?: string | null;
    /** Working days of total float from the last calculation (#5103). */
    total_float?: number | null;
  } | null;
  /** When the server computed this payload (ADR-1314). */
  as_of?: string;
  /** One server sentence per figure it defines (ADR-1314). Rendered verbatim. */
  definitions?: MetricDefinitions;
}

function useOverview2(projectId: string) {
  return useQuery<Overview2Data>({
    queryKey: ['project-overview', projectId],
    queryFn: async () =>
      (await apiClient.get<Overview2Data>(`/projects/${projectId}/overview/`)).data,
  });
}

const CARD = 'rounded-lg border border-p1-hairline bg-p1-surface-1 p-4';

/**
 * The chip beside the lead figure. Its text is the server's signed working-day
 * delta (`p80DeltaVsCommitmentDays`) — never recomputed here — with a glyph and a
 * word so color is never the message (rule 440). Null delta → no chip, because the
 * server states why in `p80DeltaVsCommitmentReason` and a chip would be a claim.
 */
export function commitmentChip(
  delta: number | null | undefined,
): { tone: StatusTone; label: string } | null {
  if (delta == null) return null;
  if (delta > 0) return { tone: 'risk', label: `+${delta}d past commitment` };
  if (delta < 0) return { tone: 'ok', label: `${Math.abs(delta)}d ahead of commitment` };
  return { tone: 'ok', label: 'on commitment' };
}

/**
 * The caveat under a lead figure that no longer describes the plan. The verdict is
 * the server's (`forecastStaleness`, #3140) and `unknown` earns no claim, as on the
 * schedule forecast bar. Word plus glyph, never color alone (rule 120).
 */
export function stalenessCaveat(
  mc: Pick<MonteCarloResult, 'forecastStaleness' | 'velocitySaturatedRuns'>,
): string[] {
  const out: string[] = [];
  if (mc.forecastStaleness === 'aged') out.push('Stale — rerun for updated forecast');
  else if (mc.forecastStaleness === 'projectChanged') out.push('Edited since this run');
  if (mc.velocitySaturatedRuns && mc.velocitySaturatedRuns > 0)
    out.push('Lower bound — some runs hit the velocity limit');
  return out;
}

export function Peer({
  label,
  date,
  definition,
}: {
  label: string;
  date: string | null | undefined;
  definition?: string;
}) {
  return (
    <div className="min-w-0 sm:min-w-[88px]">
      <div className="text-xs text-p1-text-2">
        <DefinitionTip term={label} definition={definition} />
      </div>
      <div className={`${TYPE.section} font-mono tabular-nums text-p1-text-1`}>
        {date ? fmtUtcMedium(date) : 'Not computed'}
      </div>
    </div>
  );
}

/**
 * True once the browser is idle after first paint. The run history only feeds the
 * footer's "moved from" line, so it waits until the lead figure has rendered
 * rather than competing with the two reads the page cannot render without (#5104).
 */
export function useIdleReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setReady(true));
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(() => setReady(true), 0);
    return () => window.clearTimeout(id);
  }, []);
  return ready;
}

/** The lead figure's spoken label: the date, its as-of, and any staleness caveat (#5104). */
export function leadSpokenLabel(p80Long: string, asOf: string | null, caveats: string[]): string {
  const base = `Forecast finish P80, ${p80Long}${asOf ? `, as of ${asOf}` : ''}`;
  return caveats.length > 0 ? `${base}. ${caveats.join('. ')}` : base;
}

function LeadCard({ projectId, mc }: { projectId: string; mc: MonteCarloResult }) {
  const { formatInstantTime: clock, formatInstantDate: day } = useUserDateFormat();
  const chip = commitmentChip(mc.p80DeltaVsCommitmentDays);
  const runs = mc.nSimulations ?? mc.runs;
  const caveats = stalenessCaveat(mc);
  // Phone: the chart is drawn at the card's own width so its labels keep their size
  // (a 640-wide viewBox scaled into ~340px halves the type), the peers sit in one
  // three-up row, and the "Why this date?" link is a full-width 44px target.
  const phone = useBreakpoint() === 'sm';
  const idle = useIdleReady();
  const history = useMonteCarloHistory(idle ? projectId : undefined);
  // Two server facts: the latest run's P80 and the run before it. Shown only when they differ.
  const [latest, prior] = history.data ?? [];
  const moved =
    latest?.p80 && prior?.p80 && latest.p80 === mc.p80 && prior.p80 !== latest.p80
      ? {
          from: prior.p80,
          day: day(latest.takenAt, 'medium'),
        }
      : null;
  const topId = mc.sensitivity?.[0]?.taskId;
  const { tasks } = useScheduleTasks(projectId, { enabled: !!topId });
  const driver = topId ? tasks?.find((t) => t.id === topId)?.name : undefined;
  const spoken = leadSpokenLabel(
    fmtUtcLong(mc.p80),
    mc.lastRunAt ? clock(mc.lastRunAt) : null,
    caveats,
  );
  return (
    <section
      aria-labelledby="ov2-lead-h"
      className={CARD}
      data-testid="overview2-lead"
      data-layout={phone ? 'phone' : 'wide'}
    >
      <h2 id="ov2-lead-h" className="text-xs text-p1-text-2">
        <DefinitionTip term="Forecast finish · P80" definition={mc.definitions?.p80} />
      </h2>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <p className={`${TYPE.lead} text-p1-text-1`} data-testid="overview2-lead-figure">
          <span className="sr-only">{spoken}</span>
          <span aria-hidden="true">{fmtUtcMedium(mc.p80)}</span>
        </p>
        {chip && (
          <StatusChip tone={chip.tone} label={chip.label} data-testid="overview2-commitment-chip" />
        )}
      </div>
      {caveats.length > 0 && (
        <p
          aria-hidden="true"
          className="mt-2 text-xs text-p1-risk-text"
          data-testid="overview2-staleness"
        >
          {caveats.map((c) => `◆ ${c}`).join(' · ')}
        </p>
      )}
      <div
        className={phone ? 'mt-3 grid grid-cols-3 gap-x-2' : 'mt-3 flex flex-wrap gap-x-6 gap-y-2'}
        data-testid="overview2-peers"
      >
        <Peer label="P50" date={mc.p50} definition={mc.definitions?.p50} />
        <Peer label="Commitment" date={mc.commitmentDate} definition={mc.definitions?.commitment} />
        <Peer label="CPM" date={mc.cpmFinish} />
      </div>
      <div className="mt-4">
        <SCurveChart
          {...forecastToSCurveProps(mc)}
          {...(phone ? { width: 340, height: 220 } : {})}
        />
      </div>
      <p
        className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-p1-text-3"
        data-testid="overview2-lead-footer"
      >
        {mc.lastRunAt && <span>as of {clock(mc.lastRunAt)}</span>}
        {runs > 0 && <span>· {runs.toLocaleString()} runs</span>}
        {moved && (
          <span data-testid="overview2-moved">
            · moved from {fmtUtcMedium(moved.from)} on {moved.day}
          </span>
        )}
        <Link
          className={
            phone
              ? 'flex min-h-[44px] w-full items-center text-p1-brand underline'
              : 'ml-auto text-p1-brand underline'
          }
          to={`/projects/${projectId}/schedule`}
        >
          Why this date?
          {driver && <span data-testid="overview2-driver"> Biggest driver: {driver}</span>}
        </Link>
      </p>
    </section>
  );
}

function Tile({
  term,
  definition,
  asOf,
  value,
  sub,
}: {
  term: string;
  definition?: string;
  asOf?: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className={CARD} data-testid="overview2-tile">
      <div className="text-xs text-p1-text-2">
        <DefinitionTip term={term} definition={definition} asOf={asOf} />
      </div>
      <div className={`${TYPE.tile} mt-1 text-p1-text-1`}>{value}</div>
      {sub && <div className="text-xs text-p1-text-2">{sub}</div>}
    </div>
  );
}

/**
 * Shell v2 Project Overview (#4798): one lead figure, four-or-fewer tiles, detail
 * last. Every number is the server's — this component formats and never computes.
 * A figure the server does not serve is omitted or stated as one NotComputable
 * line, never an empty tile (rule 119).
 */
/** The figures the composer's live panel shows: the forecast owner's, formatted (#4804). */
export function liveSnapshotRows(mc: MonteCarloResult | undefined): SnapshotRow[] {
  const date = (d: string | null | undefined) => (d ? fmtUtcMedium(d) : null);
  const none = mc?.p80 ? undefined : 'no forecast has run';
  return [
    {
      id: 'forecast.p80',
      label: 'Forecast finish · P80',
      value: date(mc?.p80),
      definition: mc?.definitions?.p80,
      notComputable: none,
    },
    {
      id: 'forecast.p50',
      label: 'P50',
      value: date(mc?.p50),
      definition: mc?.definitions?.p50,
      notComputable: none,
    },
    {
      id: 'forecast.cpm_finish',
      label: 'CPM finish',
      value: date(mc?.cpmFinish),
      notComputable: mc?.cpmFinish ? undefined : 'the schedule has no finish yet',
    },
  ];
}

export function ProjectOverview2({ projectId }: { projectId: string }) {
  const overview = useOverview2(projectId);
  const forecast = useMonteCarloResult(projectId);
  const { user } = useCurrentUser();
  const { role } = useCurrentUserRole(projectId);
  const shellStats = useShellStats().data;
  const projectQuery = useProject(projectId);
  const archived = projectQuery.data?.is_archived === true;
  const base = `/projects/${projectId}`;
  const o = overview.data;
  const mc = forecast.data;

  return (
    <PageFrame width="contained" header={<PageTitle visuallyHidden>Overview</PageTitle>}>
      <div className="flex flex-col gap-6 py-4" data-testid="overview2">
        {forecast.isLoading || overview.isLoading ? (
          <div
            className={`${CARD} h-64 animate-pulse`}
            data-testid="overview2-skeleton"
            role="status"
            aria-label="Loading overview"
          />
        ) : forecast.error ? (
          <div className={CARD}>
            <QueryErrorState
              variant="inline"
              message="Forecast didn’t finish; the CPM date is still current."
              onRetry={forecast.refetch}
            />
          </div>
        ) : mc?.p80 ? (
          <LeadCard projectId={projectId} mc={mc} />
        ) : (
          <div className={CARD} data-testid="overview2-empty">
            <p className={`${TYPE.section} text-p1-text-1`}>No forecast yet</p>
            {o?.tasks_with_duration_count != null && (
              <p className="text-xs text-p1-text-2" data-testid="overview2-durations">
                {o.tasks_with_duration_count} of {o.total_tasks} tasks have durations
              </p>
            )}
            <p className="text-xs text-p1-text-2">
              Run the forecast from the{' '}
              <Link className="text-p1-brand underline" to={`${base}/schedule`}>
                schedule
              </Link>
              .
            </p>
          </div>
        )}

        {overview.isError ? (
          <QueryErrorState
            variant="inline"
            message="Overview didn’t load"
            onRetry={() => void overview.refetch()}
          />
        ) : (
          o && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3" data-testid="overview2-tiles">
                <Tile
                  term="Critical tasks"
                  definition={o.definitions?.critical_task_count}
                  asOf={o.as_of}
                  value={String(o.critical_task_count)}
                />
                <Tile
                  term="Complete"
                  definition={o.definitions?.complete_tasks}
                  asOf={o.as_of}
                  value={`${o.complete_tasks} of ${o.total_tasks}`}
                  sub="tasks"
                />
                {o.open_risk_count != null && (
                  <Tile
                    term="Open risks"
                    definition={o.definitions?.open_risk_count}
                    asOf={o.as_of}
                    value={String(o.open_risk_count)}
                    sub={o.high_risk_count ? `${o.high_risk_count} high` : undefined}
                  />
                )}
              </div>
              {/* TODO(#4810): cost_computable is not served yet; until it is, the line stays and the rates link is aspirational. */}
              <NotComputable
                label="Cost variance"
                missing="no cost rates are set"
                fix={
                  <Link className="text-p1-brand underline" to={`${base}/resources`}>
                    Set rates in People
                  </Link>
                }
              />
              {o.next_milestone && (
                <section aria-labelledby="ov2-ms-h" className="flex flex-col gap-2">
                  <SectionHeading id="ov2-ms-h">Milestones</SectionHeading>
                  <Link
                    to={`${base}/tasks/${o.next_milestone.id}`}
                    className="flex items-center gap-3 text-sm text-p1-text-1 underline"
                  >
                    <span aria-hidden="true">◆</span>
                    <span>{o.next_milestone.name}</span>
                    <span className="font-mono text-xs">{fmtUtcMedium(o.next_milestone.date)}</span>
                  </Link>
                  <p
                    className="flex flex-wrap gap-x-4 text-xs text-p1-text-2"
                    data-testid="overview2-milestone-facts"
                  >
                    <span>
                      <DefinitionTip
                        term="Baseline"
                        definition={o.definitions?.next_milestone_baseline_date}
                      />{' '}
                      <span className="font-mono">
                        {o.next_milestone.baseline_date
                          ? fmtUtcMedium(o.next_milestone.baseline_date)
                          : 'not baselined'}
                      </span>
                    </span>
                    {o.next_milestone.total_float != null && (
                      <span>
                        <DefinitionTip
                          term="Float"
                          definition={o.definitions?.next_milestone_total_float}
                        />{' '}
                        <span className="font-mono">{o.next_milestone.total_float}d</span>
                      </span>
                    )}
                  </p>
                </section>
              )}
            </>
          )
        )}

        <StatusUpdatesSection
          projectId={projectId}
          userId={user?.id ?? null}
          canPost={role != null && role >= ROLE_ADMIN}
          archived={archived}
          projectCode={projectQuery.data?.code ?? null}
          // The counts-only band: a manual report is the PM's call, not the plan's reading.
          derivedBand={
            shellStats?.healthBandSource === 'derived' ? (shellStats.healthBand ?? null) : null
          }
          liveRows={liveSnapshotRows(mc ?? undefined)}
        />
      </div>
    </PageFrame>
  );
}
