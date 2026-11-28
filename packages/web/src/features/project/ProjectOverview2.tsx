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
import type { ScheduleDrivingChain } from '@/api/types';
import type { ChangelogEntry, ChangeType } from '@/features/project/activity/useProjectChangelog';
import {
  isDrivingChain,
  notComputableText,
  truncationLines,
} from '@/features/schedule/whyCritical/whyCriticalModel';
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
  /** People over 100% load in a week of the next 8, time off removed; null when withheld (#5103). */
  over_allocated_count?: number | null;
  over_allocated_reason?: 'withheld' | null;
  over_allocated_window?: { start: string; end: string } | null;
  /** The start of the changes feed: this Monday 00:00, the server's (#5103). */
  changes_since?: string;
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
  phone,
}: {
  label: string;
  date: string | null | undefined;
  definition?: string;
  phone: boolean;
}) {
  return (
    <div className="min-w-0 sm:min-w-[88px]">
      <div className="text-xs text-p1-text-2">
        <DefinitionTip term={label} definition={definition} />
      </div>
      {/* Phone: a third of a 360px card holds a 12-character date only at the 12px step. */}
      <div
        className={`${phone ? `${TYPE.mono} font-semibold` : `${TYPE.section} font-mono tabular-nums`} text-p1-text-1`}
        data-testid="overview2-peer-date"
      >
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

/**
 * The driving chain behind the lead date (#5103): the server's ADR-1381 chain through
 * the top forecast driver, fetched only once the reader asks for it, because each
 * call is a full CPM pass on the server.
 */
export function useDriverChain(projectId: string, taskId: string | undefined, open: boolean) {
  return useQuery<ScheduleDrivingChain>({
    queryKey: ['driving-chain', projectId, taskId],
    enabled: open && !!taskId,
    queryFn: async () => {
      const data: unknown = (
        await apiClient.get(`/projects/${projectId}/schedule/driving-chain/`, {
          params: { task_id: taskId },
        })
      ).data;
      if (!isDrivingChain(data)) throw new Error('Unexpected driving-chain payload');
      return data;
    },
  });
}

/** Reading order for the chain: furthest upstream first, the driver, then down to the finish. */
export function chainOrder(chain: ScheduleDrivingChain): ScheduleDrivingChain['nodes'] {
  const rank = { upstream: 0, self: 1, downstream: 2 } as const;
  return [...chain.nodes].sort(
    (a, b) =>
      rank[a.direction] - rank[b.direction] ||
      (a.direction === 'upstream' ? b.hops - a.hops : a.hops - b.hops),
  );
}

function DriverChain({ projectId, taskId }: { projectId: string; taskId: string }) {
  const q = useDriverChain(projectId, taskId, true);
  if (q.isLoading)
    return (
      <p role="status" className="text-xs text-p1-text-2">
        Loading the driver chain…
      </p>
    );
  if (q.error || !q.data)
    return (
      <QueryErrorState
        variant="inline"
        message="The driver chain didn’t load."
        onRetry={() => void q.refetch()}
      />
    );
  const chain = q.data;
  if (!chain.computable)
    return <p className="text-xs text-p1-text-2">{notComputableText(chain.reason, false)}</p>;
  return (
    <div data-testid="overview2-driver-chain">
      <ol className="flex flex-col gap-1 text-xs" aria-label="Driver chain">
        {chainOrder(chain).map((n) => (
          <li key={n.task_id} className="flex flex-wrap items-baseline gap-x-2">
            <span aria-hidden="true">{n.direction === 'self' ? '◆' : '→'}</span>
            <Link
              className="text-p1-text-1 underline"
              to={`/projects/${projectId}/tasks/${n.task_id}`}
            >
              {n.name}
            </Link>
            {n.early_finish && (
              <span className="font-mono text-p1-text-2">
                finishes {fmtUtcMedium(n.early_finish)}
              </span>
            )}
            {n.direction === 'self' && <span className="text-p1-text-2">· biggest driver</span>}
            {n.is_project_finish && <span className="text-p1-text-2">· project finish</span>}
          </li>
        ))}
      </ol>
      {truncationLines(chain).map((line) => (
        <p key={line} className="text-xs text-p1-text-3">
          {line}
        </p>
      ))}
    </div>
  );
}

function LeadCard({ projectId, mc }: { projectId: string; mc: MonteCarloResult }) {
  const [chainOpen, setChainOpen] = useState(false);
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
        <Peer label="P50" date={mc.p50} definition={mc.definitions?.p50} phone={phone} />
        <Peer
          label="Commitment"
          date={mc.commitmentDate}
          definition={mc.definitions?.commitment}
          phone={phone}
        />
        <Peer label="CPM" date={mc.cpmFinish} phone={phone} />
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
          {/* One child, so the phone link's flex box cannot swallow the space before the driver. */}
          <span>
            Why this date?
            {driver && <span data-testid="overview2-driver"> Biggest driver: {driver}</span>}
          </span>
        </Link>
      </p>
      {topId && (
        <button
          type="button"
          className="mt-2 text-xs text-p1-brand underline"
          aria-expanded={chainOpen}
          aria-controls="ov2-driver-chain"
          onClick={() => setChainOpen((v) => !v)}
          data-testid="overview2-chain-toggle"
        >
          {chainOpen ? 'Hide the driver chain' : 'Show the driver chain'}
        </button>
      )}
      {chainOpen && topId && (
        <div id="ov2-driver-chain" className="mt-2">
          <DriverChain projectId={projectId} taskId={topId} />
        </div>
      )}
    </section>
  );
}

export function Tile({
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

type ChangesPage = { results: ChangelogEntry[]; next_cursor: string | null };

const CHANGE_WORD: Record<ChangeType, string> = {
  created: 'added',
  updated: 'changed',
  deleted: 'removed',
};

/**
 * "Changes since Monday" (#5103). The boundary is the server's `changes_since`; the
 * rows are the project changelog's own (ADR-0201), which also decides who may see
 * the actor, so this list never names one.
 */
function ChangesSince({
  projectId,
  since,
  definition,
}: {
  projectId: string;
  since: string;
  definition?: string;
}) {
  const { formatInstantDate: day } = useUserDateFormat();
  const q = useQuery<ChangesPage>({
    queryKey: ['project-overview-changes', projectId, since],
    queryFn: async () =>
      (
        await apiClient.get<ChangesPage>(`/projects/${projectId}/changelog/`, {
          params: { since, page_size: 5 },
        })
      ).data,
  });
  return (
    <section
      aria-labelledby="ov2-changes-h"
      className="flex flex-col gap-2"
      data-testid="overview2-changes"
    >
      <div className="flex flex-wrap items-baseline gap-x-3">
        <SectionHeading id="ov2-changes-h">Changes since Monday</SectionHeading>
        <span className="text-xs text-p1-text-2">
          <DefinitionTip term="What this covers" definition={definition} />
        </span>
      </div>
      {q.isLoading ? (
        <p role="status" className="text-xs text-p1-text-2">
          Loading changes…
        </p>
      ) : q.error ? (
        <QueryErrorState
          variant="inline"
          message="Changes didn’t load."
          onRetry={() => void q.refetch()}
        />
      ) : (q.data?.results ?? []).length === 0 ? (
        <p className="text-xs text-p1-text-2">No changes since Monday.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm text-p1-text-1">
          {(q.data?.results ?? []).map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-xs text-p1-text-2">{e.object_kind_label ?? e.object_type}</span>
              <span>{e.object_label}</span>
              <span className="text-xs text-p1-text-2">{CHANGE_WORD[e.change_type]}</span>
              <span className="font-mono text-xs text-p1-text-3">
                {day(e.history_date, 'medium')}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Link className="text-xs text-p1-brand underline" to={`/projects/${projectId}/activity`}>
        All changes in Activity
      </Link>
    </section>
  );
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
  // The desktop column count follows the tiles actually served: a withheld or
  // absent figure drops its tile, and a fixed four-column grid would leave a gap.
  // Literal class names so Tailwind's scanner keeps all three.
  const tileCount = o
    ? 2 + (o.over_allocated_count != null ? 1 : 0) + (o.open_risk_count != null ? 1 : 0)
    : 0;
  const lgCols =
    tileCount >= 4 ? 'lg:grid-cols-4' : tileCount === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-2';
  const tiles = o ? (
    <div className={`grid grid-cols-2 gap-3 ${lgCols}`} data-testid="overview2-tiles">
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
      {o.over_allocated_count != null && (
        <Tile
          term="Over-allocated"
          definition={o.definitions?.over_allocated_count}
          asOf={o.as_of}
          value={String(o.over_allocated_count)}
          sub={`${o.over_allocated_count === 1 ? 'person' : 'people'}${
            o.over_allocated_window ? ` through ${fmtUtcMedium(o.over_allocated_window.end)}` : ''
          }`}
        />
      )}
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
  ) : null;
  const costLine = (
    // TODO(#4810): cost_computable is not served yet; until it is, the line stays and the rates link is aspirational.
    <NotComputable
      label="Cost variance"
      missing="no cost rates are set"
      fix={
        <Link className="text-p1-brand underline" to={`${base}/resources`}>
          Set rates in People
        </Link>
      }
    />
  );

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
              {tiles}
              {costLine}
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
              {o.changes_since && (
                <ChangesSince
                  projectId={projectId}
                  since={o.changes_since}
                  definition={o.definitions?.changes_since}
                />
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
