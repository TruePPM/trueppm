import { useState, useEffect, useRef } from 'react';
import type { GanttEngine } from './engine';
import type { Task } from '@/types';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useRunMonteCarlo } from '@/hooks/useRunMonteCarlo';
import { formatRelative } from '@/lib/formatRelative';
import { MC_ROW_HEIGHT } from './scheduleConstants';
import { MonteCarloLabel } from './MonteCarloLabel';
import { MonteCarloTimeline } from './MonteCarloTimeline';
import { MonteCarloDetailPanel } from './MonteCarloDetailPanel';

interface Props {
  /** GanttEngine instance — null until the canvas Gantt has initialised */
  engine: GanttEngine | null;
  projectId?: string;
  /** Total width of the task list panel — keeps the label column aligned. */
  taskListWidth: number;
  /**
   * ISO date of the deterministic CPM finish (max scheduled task finish).
   * Passed from ScheduleView where allTasks is available. Null when no tasks.
   * Used to compute the P80 risk delta shown in the timeline chips.
   */
  cpmFinish?: string | null;
  /**
   * Increments whenever any task mutation (drag, resize, etc.) succeeds.
   * Causes the strip to enter the "stale — rerun for updated forecast" state.
   */
  mutationVersion?: number;
  /** Full task list — forwarded to MonteCarloDetailPanel for top-drivers section. */
  tasks?: Task[];
}

function daysBetween(a: string, b: string): number {
  const msA = new Date(a + 'T00:00:00Z').getTime();
  const msB = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((msB - msA) / 86_400_000);
}

const BTN_CLS =
  'inline-flex items-center h-7 px-3 rounded border border-neutral-border bg-neutral-surface ' +
  'text-xs font-medium text-neutral-text-primary ' +
  'hover:bg-neutral-surface-raised disabled:opacity-50 disabled:cursor-not-allowed ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

/**
 * Full-width strip below the Gantt split pane showing P50/P80/P95 date chips.
 *
 * Hidden on screens narrower than md (768px) — mobile uses `MobileMonteCarloCard`.
 * When no simulation result is cached, renders a "Run Monte Carlo" CTA.
 *
 * When `mutationVersion` increments (any task edit), the strip enters an `isStale`
 * state showing "⟳ Stale" alongside the last-known chips, encouraging a Rerun.
 * State clears when `result.lastRunAt` changes (i.e. a fresh simulation completes).
 */
export function MonteCarloRow({
  engine: _engine,
  projectId,
  taskListWidth,
  cpmFinish,
  mutationVersion = 0,
  tasks = [],
}: Props) {
  const { data: result, isLoading } = useMonteCarloResult(projectId);
  const runMc = useRunMonteCarlo(projectId);
  const [detailOpen, setDetailOpen] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const seenLastRunAt = useRef<string | undefined>(undefined);
  const seenMutationVersion = useRef(mutationVersion);

  // Mark stale when a task mutation fires.
  useEffect(() => {
    if (mutationVersion !== seenMutationVersion.current) {
      seenMutationVersion.current = mutationVersion;
      if (result) setIsStale(true);
    }
  }, [mutationVersion, result]);

  // Clear stale when a new simulation result arrives.
  useEffect(() => {
    if (result?.lastRunAt && result.lastRunAt !== seenLastRunAt.current) {
      seenLastRunAt.current = result.lastRunAt;
      setIsStale(false);
    }
  }, [result?.lastRunAt]);

  const isRecomputing = runMc.isPending || isStale;

  const p80DeltaDays =
    cpmFinish && result ? daysBetween(cpmFinish, result.p80) : null;

  if (!result) {
    if (!projectId) return null;
    return (
      <div
        className="hidden md:flex flex-row items-center gap-3 flex-shrink-0 border-t border-neutral-border px-4"
        style={{ height: MC_ROW_HEIGHT }}
        aria-label="Monte Carlo confidence row — no simulation run yet"
      >
        <span className="text-xs font-medium text-neutral-text-secondary tracking-wide uppercase">
          Monte Carlo
        </span>
        <span className="text-xs text-neutral-text-secondary">
          {isLoading
            ? 'Loading forecast…'
            : runMc.isError
              ? 'Could not run simulation. Try again.'
              : 'Run a simulation to see P50/P80/P95 finish-date probabilities.'}
        </span>
        <button
          type="button"
          onClick={() => runMc.mutate({})}
          disabled={runMc.isPending || isLoading}
          className={`ml-auto ${BTN_CLS}`}
        >
          {runMc.isPending ? 'Running…' : 'Run Monte Carlo'}
        </button>
      </div>
    );
  }

  return (
    <>
      <div
        className="hidden md:flex flex-row flex-shrink-0 border-t border-neutral-border"
        style={{ height: MC_ROW_HEIGHT }}
        aria-label="Monte Carlo confidence row"
      >
        <MonteCarloLabel width={taskListWidth} isStale={isRecomputing} />
        <MonteCarloTimeline result={result} p80DeltaDays={p80DeltaDays} />
        <div className="flex items-center gap-2 px-3 shrink-0 border-l border-neutral-border">
          {isRecomputing ? (
            <span
              data-testid="mc-recomputing"
              className="text-xs text-neutral-text-secondary tppm-mono whitespace-nowrap"
              aria-live="polite"
            >
              {runMc.isPending ? 'Recomputing…' : 'Stale — rerun for updated forecast'}
            </span>
          ) : (
            result.lastRunAt && (
              <span className="text-xs text-neutral-text-disabled tppm-mono whitespace-nowrap">
                {formatRelative(new Date(result.lastRunAt))}
              </span>
            )
          )}
          <button
            type="button"
            onClick={() => setDetailOpen(true)}
            data-testid="mc-details-btn"
            aria-label="Open Monte Carlo detail panel"
            className={BTN_CLS}
          >
            Details ›
          </button>
          <button
            type="button"
            onClick={() => runMc.mutate({})}
            disabled={runMc.isPending}
            aria-label="Rerun Monte Carlo forecast"
            title="Rerun Monte Carlo forecast"
            className={BTN_CLS}
          >
            {runMc.isPending ? 'Rerunning…' : 'Rerun'}
          </button>
        </div>
      </div>

      <MonteCarloDetailPanel
        result={result}
        cpmFinish={cpmFinish ?? null}
        tasks={tasks}
        isOpen={detailOpen}
        onClose={() => setDetailOpen(false)}
      />
    </>
  );
}
