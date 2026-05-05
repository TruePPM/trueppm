import type { GanttEngine } from './engine';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { useRunMonteCarlo } from '@/hooks/useRunMonteCarlo';
import { formatRelative } from '@/lib/formatRelative';
import { MC_ROW_HEIGHT } from './scheduleConstants';
import { MonteCarloLabel } from './MonteCarloLabel';
import { MonteCarloTimeline } from './MonteCarloTimeline';

interface Props {
  /** GanttEngine instance — null until the canvas Gantt has initialised */
  engine: GanttEngine | null;
  projectId?: string;
  /** Total width of the task list panel — keeps the label column aligned. */
  taskListWidth: number;
}

/**
 * Full-width strip below the Gantt split pane showing the Monte Carlo
 * distribution histogram and P50/P80/P95 date chips.
 *
 * Hidden on screens narrower than md (768px) — mobile uses
 * `MobileMonteCarloCard`. When no simulation result is cached for the
 * project, renders an inline "Run Monte Carlo" CTA so the row remains
 * visible (the previous behavior of returning null hid the entire feature
 * from users who had not yet run a simulation).
 *
 * The `engine` prop is retained for role-gating (rule 47) and future
 * engine-event wiring; it is not used for scroll sync in this layout.
 */
export function MonteCarloRow({ engine: _engine, projectId, taskListWidth }: Props) {
  const { data: result, isLoading } = useMonteCarloResult(projectId);
  const runMc = useRunMonteCarlo(projectId);

  if (!result) {
    // No project context yet — render nothing rather than a CTA that cannot fire.
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
          className="ml-auto inline-flex items-center h-7 px-3 rounded border border-neutral-border bg-neutral-surface
            text-xs font-medium text-neutral-text-primary
            hover:bg-neutral-surface-raised disabled:opacity-50 disabled:cursor-not-allowed
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          {runMc.isPending ? 'Running…' : 'Run Monte Carlo'}
        </button>
      </div>
    );
  }

  return (
    <div
      className="hidden md:flex flex-row flex-shrink-0 border-t border-neutral-border"
      style={{ height: MC_ROW_HEIGHT }}
      aria-label="Monte Carlo confidence row"
    >
      <MonteCarloLabel width={taskListWidth} />
      <MonteCarloTimeline result={result} />
      <div className="flex items-center gap-3 px-3 shrink-0 border-l border-neutral-border">
        {result.lastRunAt && (
          <span className="text-xs text-neutral-text-disabled tppm-mono whitespace-nowrap">
            {formatRelative(new Date(result.lastRunAt))}
          </span>
        )}
        <button
          type="button"
          onClick={() => runMc.mutate({})}
          disabled={runMc.isPending}
          aria-label="Rerun Monte Carlo forecast"
          title="Rerun Monte Carlo forecast"
          className="inline-flex items-center h-7 px-3 rounded border border-neutral-border bg-neutral-surface
            text-xs font-medium text-neutral-text-primary
            hover:bg-neutral-surface-raised disabled:opacity-50 disabled:cursor-not-allowed
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          {runMc.isPending ? 'Rerunning…' : 'Rerun'}
        </button>
      </div>
    </div>
  );
}
