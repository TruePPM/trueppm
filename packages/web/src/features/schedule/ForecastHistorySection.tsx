import { useState } from 'react';
import {
  useMonteCarloHistory,
  type MonteCarloRunHistoryItem,
} from '@/hooks/useMonteCarloHistory';
import { deltaToneClass, fmtForecastDate, formatDelta } from './forecastDelta';

interface Props {
  projectId?: string;
  /** Collapsed by default on small screens (mobile sheet); expanded on desktop. */
  defaultExpanded?: boolean;
}

const INITIAL_VISIBLE = 10;

/**
 * Collapsible "Forecast history" section for the Monte Carlo drawer / sheet
 * (ADR-0109, #961). Read-only. Shows persisted runs newest-first with a per-run
 * delta vs the previous run so a PM can read finish-date forecast drift over
 * time. Renders nothing when no run has ever been recorded (the run CTA lives
 * elsewhere); loading / error / single-run / cap states are handled inline.
 */
export function ForecastHistorySection({ projectId, defaultExpanded = true }: Props) {
  const { data, cap, isLoading, error, refetch } = useMonteCarloHistory(projectId);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showAll, setShowAll] = useState(false);

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
              <ol role="list" className="divide-y divide-neutral-border">
                {visible.map((run) => (
                  <ForecastHistoryRow key={run.id} run={run} />
                ))}
              </ol>
              {!showAll && runs.length > INITIAL_VISIBLE && (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="mt-2 text-xs text-brand-primary underline hover:no-underline
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

function ForecastHistoryRow({ run }: { run: MonteCarloRunHistoryItem }) {
  const when = new Date(run.takenAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const isBaseline = run.delta === null;
  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <span className="text-xs text-neutral-text-secondary tppm-mono">{when}</span>
          {isBaseline && (
            <span className="text-xs text-neutral-text-disabled">— baseline</span>
          )}
        </span>
        {/* Attribution is present only for Admin/Owner (API-gated); when absent
            we render nothing so the row reads as complete for other members. */}
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
