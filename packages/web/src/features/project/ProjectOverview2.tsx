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
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { fmtUtcLong, fmtUtcMedium } from '@/lib/formatUtcDate';
import type { MetricDefinitions, MonteCarloResult } from '@/types';

/** The slice of `GET /projects/:id/overview/` this page reads. Every figure is the server's. */
export interface Overview2Data {
  critical_task_count: number;
  total_tasks: number;
  complete_tasks: number;
  open_risk_count?: number;
  high_risk_count?: number;
  next_milestone: { id: string; name: string; date: string; percent_complete: number } | null;
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

function Peer({
  label,
  date,
  definition,
}: {
  label: string;
  date: string | null | undefined;
  definition?: string;
}) {
  return (
    <div className="min-w-[88px]">
      <div className="text-xs text-p1-text-2">
        <DefinitionTip term={label} definition={definition} />
      </div>
      <div className={`${TYPE.section} font-mono tabular-nums text-p1-text-1`}>
        {date ? fmtUtcMedium(date) : 'Not computed'}
      </div>
    </div>
  );
}

function LeadCard({ projectId, mc }: { projectId: string; mc: MonteCarloResult }) {
  const { formatInstantTime: clock } = useUserDateFormat();
  const chip = commitmentChip(mc.p80DeltaVsCommitmentDays);
  const runs = mc.nSimulations ?? mc.runs;
  const spoken = `Forecast finish P80, ${fmtUtcLong(mc.p80)}${mc.lastRunAt ? `, as of ${clock(mc.lastRunAt)}` : ''}`;
  return (
    <section aria-labelledby="ov2-lead-h" className={CARD} data-testid="overview2-lead">
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
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
        <Peer label="P50" date={mc.p50} definition={mc.definitions?.p50} />
        <Peer label="Commitment" date={mc.commitmentDate} definition={mc.definitions?.commitment} />
        <Peer label="CPM" date={mc.cpmFinish} />
      </div>
      <div className="mt-4">
        <SCurveChart {...forecastToSCurveProps(mc)} />
      </div>
      <p
        className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-p1-text-3"
        data-testid="overview2-lead-footer"
      >
        {mc.lastRunAt && <span>as of {clock(mc.lastRunAt)}</span>}
        {runs > 0 && <span>· {runs.toLocaleString()} runs</span>}
        <Link className="ml-auto text-p1-brand underline" to={`/projects/${projectId}/schedule`}>
          Why this date?
        </Link>
      </p>
    </section>
  );
}

function Tile({
  term,
  definition,
  value,
  sub,
}: {
  term: string;
  definition?: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className={CARD} data-testid="overview2-tile">
      <div className="text-xs text-p1-text-2">
        <DefinitionTip term={term} definition={definition} />
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
export function ProjectOverview2({ projectId }: { projectId: string }) {
  const overview = useOverview2(projectId);
  const forecast = useMonteCarloResult(projectId);
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
                  value={String(o.critical_task_count)}
                />
                <Tile
                  term="Complete"
                  definition={o.definitions?.complete_tasks}
                  value={`${o.complete_tasks} of ${o.total_tasks}`}
                  sub="tasks"
                />
                {o.open_risk_count != null && (
                  <Tile
                    term="Open risks"
                    definition={o.definitions?.open_risk_count}
                    value={String(o.open_risk_count)}
                    sub={o.high_risk_count ? `${o.high_risk_count} high` : undefined}
                  />
                )}
              </div>
              {/* cost_computable is not served yet (#4809/#4810); until it is, the line stays. */}
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
                </section>
              )}
            </>
          )
        )}
      </div>
    </PageFrame>
  );
}
