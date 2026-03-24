import { useState, useEffect } from 'react';
import type { GanttEngine } from './engine';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { MC_ROW_HEIGHT } from './ganttConstants';
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
 * Full-width strip below the Gantt split pane showing Monte Carlo confidence
 * lines (P50/P80/P95) aligned to the same date axis as the canvas timeline.
 *
 * Hidden on screens narrower than md (768px) — mobile surface is deferred.
 * Renders nothing if no MC result is available (first load, loading state).
 */
export function MonteCarloRow({ engine, projectId, taskListWidth }: Props) {
  const [scrollLeft, setScrollLeft] = useState(engine?.scrollLeft ?? 0);
  const scales = engine?.scales ?? null;
  const { data: result } = useMonteCarloResult(projectId);

  // Track scroll via engine.on('scroll') (rule 55: always unsubscribe)
  useEffect(() => {
    if (!engine) return;
    const off = engine.on('scroll', (ev) => {
      setScrollLeft(ev.scrollLeft);
    });
    return off;
  }, [engine]);

  if (!result) return null;

  return (
    <div
      className="hidden md:flex flex-row flex-shrink-0 border-t border-neutral-border"
      style={{ height: MC_ROW_HEIGHT }}
      aria-label="Monte Carlo confidence row"
    >
      <MonteCarloLabel width={taskListWidth} p80Date={result.p80} />
      <MonteCarloTimeline result={result} scrollLeft={scrollLeft} scales={scales} />
    </div>
  );
}
