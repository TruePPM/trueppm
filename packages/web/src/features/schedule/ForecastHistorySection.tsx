import { useState } from 'react';
import {
  useMonteCarloHistory,
  useMonteCarloRunDistribution,
  type MonteCarloRunHistoryItem,
} from '@/hooks/useMonteCarloHistory';
import { deltaToneClass, fmtForecastDate, formatDelta } from './forecastDelta';
import { MonteCarloHistogram } from './MonteCarloHistogram';

interface Props {
  projectId?: string;
  /** Collapsed by default on small screens (mobile sheet); expanded on desktop. */
  defaultExpanded?: boolean;
}

const INITIAL_VISIBLE = 10;

/**
 * Collapsible "Forecast history" section for the Monte Carlo surfaces (ADR-0175,
 * issue 961; persisted-distribution read-path ADR-0144, issue 1231). Read-only. Shows
 * persisted runs newest-first with a per-run delta vs the previous run so a PM
 * can read finish-date forecast drift over time, and lets a run be expanded to
 * re-view its persisted distribution histogram.
 *
 * The list is visible to all project members; `triggeredByName` attribution is
 * gated server-side (ADR-0144) and rendered only when present. When the
 * workspace has turned history off (`enabled: false`) a quiet note replaces the
 * list rather than rendering an empty shell. Renders nothing when no run has
 * ever been recorded.
 */
export function ForecastHistorySection({ projectId, defaultExpanded = true }: Props) {
  const { data, cap, enabled, isLoading, error, refetch } = useMonteCarloHistory(projectId);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showAll, setShowAll] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  // History disabled for this workspace (ADR-0144, issue 1232): the endpoint returns
  // enabled:false with an empty list. Show a quiet note, not the list shell.
  if (enabled === false) {
    return (
      <section aria-label="Forecast history" className="border-t border-neutral-border mt-2">
        <p className="px-5 py-3 text-xs text-neutral-text-secondary">
          Run history is turned off for this workspace.
        </p>
      </section>
    );
  }

  // Empty state (never run): render nothing — the "Run forecast" CTA elsewhere
  // is the only affordance, and an empty history shell reads as broken.
  if (!isLoading && !error && (!data || data.length === 0)) {
    return null;
  }

  const runs = data ?? [];
  const visible = showAll ? runs : runs.slice(0, INITIAL_VISIBLE);
  const atCap = cap !== null && runs.length >= cap;

  return (
    <section
      aria-label="Forecast history"
      className="border-t border-neutral-border mt-2"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-5 py-3 min-h-[44px]
          text-left hover:bg-neutral-surface-raised
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset focus-visible:outline-none"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-neutral-text-primary">
          <span aria-hidden="true" className="text-neutral-text-secondary">
            {expanded ? '▾' : '▸'}
          </span>
          Forecast history
        </span>
        <span className="text-xs text-neutral-text-secondary">
          {isLoading
            ? 'Loading…'
            : `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}${
                atCap ? ' · cap reached' : cap !== null ? ` · cap ${cap}` : ''
              }`}
        </span>
      </button>

      {expanded && (
        <div className="px-5 pb-5">
          {isLoading && <HistorySkeleton />}

          {error && (
            <div className="py-3 text-xs text-neutral-text-secondary">
              Couldn&rsquo;t load forecast history.{' '}
              <button
                type="button"
                onClick={refetch}
                className="text-brand-primary underline hover:no-underline
                  focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
              >
                Try again
              </button>
            </div>
          )}

          {!isLoading && !error && (
            <>
              {runs.length === 1 && (
                <p className="pt-1 pb-2 text-xs text-neutral-text-secondary">
                  Run again later to see how the forecast moves.
                </p>
              )}
              <ol className="divide-y divide-neutral-border">
                {visible.map((run) => (
                  <ForecastHistoryRow
                    key={run.id}
                    run={run}
                    projectId={projectId}
                    isOpen={openRunId === run.id}
                    onToggle={() =>
                      setOpenRunId((prev) => (prev === run.id ? null : run.id))
                    }
                  />
                ))}
              </ol>
              {!showAll && runs.length > INITIAL_VISIBLE && (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="mt-2 min-h-[44px] inline-flex items-center text-xs text-brand-primary
                    underline hover:no-underline
                    focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
                >
                  Show older runs ({runs.length - INITIAL_VISIBLE})
                </button>
              )}
              {atCap && (
                <p className="mt-2 text-xs text-neutral-text-disabled">
                  Older runs are trimmed.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ForecastHistoryRow({
  run,
  projectId,
  isOpen,
  onToggle,
}: {
  run: MonteCarloRunHistoryItem;
  projectId?: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const when = new Date(run.takenAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const isBaseline = run.delta === null;
  // Fetch the persisted distribution only when this row is expanded (issue 1231).
  const { result, isLoading, error } = useMonteCarloRunDistribution(projectId, run.id, isOpen);
  const panelId = `forecast-run-dist-${run.id}`;
  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <span className="text-xs text-neutral-text-secondary tppm-mono">{when}</span>
          {isBaseline && (
            <span className="text-xs text-neutral-text-disabled">— baseline</span>
          )}
        </span>
        {/* Attribution is present only for the resolved audience (API-gated,
            ADR-0144); when absent we render nothing so the row reads complete. */}
        {run.triggeredByName && (
          <span className="text-xs text-neutral-text-secondary">
            run by {run.triggeredByName}
          </span>
        )}
      </div>
      <div className="mt-1 space-y-0.5">
        <PercentileLine label="P50" date={run.p50} days={run.delta?.p50 ?? null} />
        <PercentileLine label="P80" date={run.p80} days={run.delta?.p80 ?? null} />
        <PercentileLine label="P95" date={run.p95} days={run.delta?.p95 ?? null} />
      </div>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={onToggle}
        className="mt-1.5 inline-flex items-center gap-1 text-xs text-brand-primary
          underline hover:no-underline min-h-[28px]
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
      >
        <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
        {isOpen ? 'Hide distribution' : 'View distribution'}
      </button>
      {isOpen && (
        <div id={panelId} className="mt-2">
          {isLoading && (
            <p className="text-xs text-neutral-text-secondary">Loading distribution…</p>
          )}
          {error && (
            <p className="text-xs text-neutral-text-secondary">
              Couldn&rsquo;t load this run&rsquo;s distribution.
            </p>
          )}
          {!isLoading && !error && result && (
            // The persisted distribution drives the histogram directly. Sensitivity
            // task names are joined from the live task list elsewhere; the history
            // row shows the distribution shape only, so an empty tasks list is fine.
            <MonteCarloHistogram result={result} />
          )}
        </div>
      )}
    </li>
  );
}

function PercentileLine({
  label,
  date,
  days,
}: {
  label: string;
  date: string | null;
  days: number | null;
}) {
  const delta = formatDelta(days);
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="flex items-baseline gap-2">
        <span className="uppercase tracking-widest text-neutral-text-disabled w-8">{label}</span>
        <span className="tppm-mono text-neutral-text-primary">{fmtForecastDate(date)}</span>
      </span>
      {delta && (
        <span className={`tppm-mono ${deltaToneClass(delta.tone)}`}>
          <span aria-hidden="true">
            {delta.glyph} {delta.text}
          </span>
          <span className="sr-only">{`${label} ${delta.aria}`}</span>
        </span>
      )}
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div className="py-2 space-y-3" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-1.5">
          <div className="h-3 w-24 rounded bg-neutral-surface-raised motion-safe:animate-pulse" />
          <div className="h-3 w-full rounded bg-neutral-surface-raised motion-safe:animate-pulse" />
          <div className="h-3 w-full rounded bg-neutral-surface-raised motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}
