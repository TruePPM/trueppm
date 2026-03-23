import type { IApi } from '@svar-ui/gantt-store';
import { useSvarScale } from '@/hooks/useSvarScale';
import { useMonteCarloResult } from '@/hooks/useMonteCarloResult';
import { MC_ROW_HEIGHT } from './ganttConstants';
import { MonteCarloLabel } from './MonteCarloLabel';
import { MonteCarloTimeline } from './MonteCarloTimeline';

interface Props {
  /** SVAR IApi instance — null until Gantt has initialised */
  ganttApi: IApi | null;
  projectId?: string;
}

/**
 * Full-width strip below the Gantt split pane showing Monte Carlo confidence
 * lines (P50/P80/P95) aligned to the same date axis as the SVAR timeline.
 *
 * Hidden on screens narrower than md (768px) — mobile surface is deferred.
 * Renders nothing if no MC result is available (first load, loading state).
 */
export function MonteCarloRow({ ganttApi, projectId }: Props) {
  const { scrollLeft, scales } = useSvarScale(ganttApi);
  const { data: result } = useMonteCarloResult(projectId);

  if (!result) return null;

  return (
    <div
      className="hidden md:flex flex-row flex-shrink-0 border-t border-neutral-border"
      style={{ height: MC_ROW_HEIGHT }}
      aria-label="Monte Carlo confidence row"
    >
      <MonteCarloLabel />
      <MonteCarloTimeline result={result} scrollLeft={scrollLeft} scales={scales} />
    </div>
  );
}
