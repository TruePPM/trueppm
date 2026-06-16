import { useState } from 'react';
import type { Task } from '@/types';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { MonteCarloHistogram } from './MonteCarloHistogram';
import { SensitivityList } from './SensitivityList';

interface Props {
  projectId?: string;
  /** Loaded tasks — joined by id to name the sensitivity bars. */
  tasks: Task[];
}

const EXPANDED_KEY = 'schedule.insightsExpanded';

function readExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === 'true';
  } catch {
    return false;
  }
}

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
    new Date(iso),
  );
}

/**
 * "Forecast & sensitivity" — the docked, collapsible Monte Carlo insights bar at
 * the bottom of the Schedule view (ADR-0139, v2 redesign `S.schedule`).
 *
 * Collapsed (the default): a single header row with the one-line summary
 * (P50 · P80 · P95 · top driver). Expanded: two columns — the finish-date
 * forecast (histogram + P50/P80/P95 commit stats) and "What's holding the date"
 * (the duration-sensitivity tornado). It only renders once a simulation result
 * exists; the no-run "Run a simulation" prompt lives in `MonteCarloRow` above, so
 * the two never both claim the empty state.
 *
 * Desktop-only (`hidden md:block`) — mobile uses `MobileMonteCarloCard`. The
 * expand state persists per-user in localStorage; collapse keeps the chart out
 * of the way for users who only need the chips above.
 */
export function ScheduleInsightsBar({ projectId, tasks }: Props) {
  const { data: result } = useMonteCarloResult(projectId);
  const [expanded, setExpanded] = useState(readExpanded);

  if (!result) return null;

  function toggle() {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(EXPANDED_KEY, String(next));
      } catch {
        // Private mode / SSR — the in-memory value still drives the session.
      }
      return next;
    });
  }

  const topDriver = result.sensitivity
    .map((s) => tasks.find((t) => t.id === s.taskId)?.name)
    .find((name): name is string => Boolean(name));

  const panelId = 'schedule-insights-panel';

  return (
    <section
      className="hidden md:block flex-shrink-0 border-t border-neutral-border bg-neutral-surface"
      aria-label="Forecast and sensitivity"
    >
      <h2 className="m-0">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="flex w-full items-center gap-2 px-5 py-2.5 text-left text-sm font-semibold text-neutral-text-primary
            hover:bg-neutral-surface-raised
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary dark:focus-visible:ring-semantic-on-track"
        >
          <span aria-hidden="true" className="text-xs text-neutral-text-secondary">
            {expanded ? '▾' : '▸'}
          </span>
          <span>Forecast &amp; sensitivity</span>
          <span className="ml-auto truncate text-xs font-normal tppm-mono text-neutral-text-secondary">
            P50 {fmtDate(result.p50)} ·{' '}
            <b className="font-semibold text-semantic-at-risk">P80 {fmtDate(result.p80)}</b> · P95{' '}
            {fmtDate(result.p95)}
            {topDriver ? ` · top driver: ${topDriver}` : ''}
          </span>
        </button>
      </h2>

      {expanded && (
        <div
          id={panelId}
          className="grid grid-cols-1 gap-5 px-5 pb-5 pt-1 lg:grid-cols-2"
        >
          {/* Finish-date forecast */}
          <div className="rounded-lg border border-neutral-border p-4">
            <h3 className="text-sm font-semibold text-neutral-text-primary">Finish-date forecast</h3>
            <p className="mb-3 text-xs text-neutral-text-secondary">
              Monte Carlo · {result.runs.toLocaleString()} runs · P50–P80 band
            </p>
            <MonteCarloHistogram result={result} />
            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-neutral-border pt-3">
              <ForecastStat label="P50" date={fmtDate(result.p50)} />
              <ForecastStat label="P80 · commit" date={fmtDate(result.p80)} accent />
              <ForecastStat label="P95" date={fmtDate(result.p95)} />
            </div>
          </div>

          {/* What's holding the date — sensitivity tornado */}
          <div className="rounded-lg border border-neutral-border p-4">
            <h3 className="text-sm font-semibold text-neutral-text-primary">
              What&apos;s holding the date
            </h3>
            <p className="mb-3 text-xs text-neutral-text-secondary">
              Sensitivity · tasks whose duration moves the finish most
            </p>
            <SensitivityList sensitivity={result.sensitivity} tasks={tasks} />
          </div>
        </div>
      )}
    </section>
  );
}

function ForecastStat({ label, date, accent = false }: { label: string; date: string; accent?: boolean }) {
  return (
    <div>
      <div
        className={`text-xs tppm-mono ${accent ? 'text-semantic-at-risk' : 'text-neutral-text-secondary'}`}
      >
        {label}
      </div>
      <div className="text-sm tppm-mono text-neutral-text-primary">{date}</div>
    </div>
  );
}
