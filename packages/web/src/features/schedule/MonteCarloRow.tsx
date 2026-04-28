import type { GanttEngine } from './engine';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
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
 * Hidden on screens narrower than md (768px) — mobile surface is deferred.
 * Renders nothing if no MC result is available (first load, loading state).
 *
 * The `engine` prop is retained for role-gating (rule 47) and future
 * engine-event wiring; it is not used for scroll sync in this layout.
 */
export function MonteCarloRow({ engine: _engine, projectId, taskListWidth }: Props) {
  const { data: result } = useMonteCarloResult(projectId);

  if (!result) return null;

  return (
    <div
      className="hidden md:flex flex-row flex-shrink-0 border-t border-neutral-border"
      style={{ height: MC_ROW_HEIGHT }}
      aria-label="Monte Carlo confidence row"
    >
      <MonteCarloLabel width={taskListWidth} p80Date={result.p80} />
      <MonteCarloTimeline result={result} />
    </div>
  );
}
