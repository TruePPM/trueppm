import { useRef, useMemo, useCallback, useState } from 'react';
import type { IApi } from '@svar-ui/gantt-store';
import './gantt.css';
import '@svar-ui/react-gantt/style.css';
import { useGanttTasks } from '@/hooks/useGanttTasks';
import { useGanttStore } from '@/stores/ganttStore';
import { useScrollSync } from '@/hooks/useScrollSync';
import { toSvarTasks } from './adapters/toSvarTasks';
import { toSvarLinks } from './adapters/toSvarLinks';
import { TaskListPanel } from './TaskListPanel';
import { GanttTimeline } from './GanttTimeline';
import { ZoomControl } from './ZoomControl';
import { MonteCarloRow } from './MonteCarloRow';

export function GanttView() {
  const { tasks, links, isLoading, error } = useGanttTasks();
  const zoomLevel = useGanttStore((s) => s.zoomLevel);

  const taskListScrollRef = useRef<HTMLDivElement>(null);
  const ganttApiRef = useRef<IApi | null>(null);
  // ganttApi as state so useSvarScale re-runs when the API becomes available
  const [ganttApi, setGanttApi] = useState<IApi | null>(null);

  useScrollSync(taskListScrollRef, ganttApiRef);

  const handleApiReady = useCallback((api: IApi) => {
    ganttApiRef.current = api;
    setGanttApi(api);
  }, []);

  // Adapt TruePPM data to SVAR shapes — memoized on raw array reference
  const svarTasks = useMemo(() => (tasks ? toSvarTasks(tasks) : []), [tasks]);
  const svarLinks = useMemo(() => (links ? toSvarLinks(links) : []), [links]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-semantic-critical">
          Couldn&apos;t load tasks.{' '}
          <button
            type="button"
            className="underline focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </p>
      </div>
    );
  }

  if (isLoading || !tasks) {
    return (
      <div className="flex h-full" aria-busy="true" aria-label="Loading Gantt">
        {/* Task list skeleton */}
        <div className="w-[280px] flex-shrink-0 border-r border-neutral-border p-2 space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-7 rounded animate-pulse bg-neutral-surface-raised" />
          ))}
        </div>
        <div className="flex-1 bg-neutral-surface" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar row */}
      <div className="flex items-center justify-end px-4 h-10 border-b border-neutral-border bg-neutral-surface-raised flex-shrink-0">
        <ZoomControl />
      </div>

      {/* Split pane */}
      <div className="flex flex-1 overflow-hidden">
        <TaskListPanel tasks={tasks} scrollRef={taskListScrollRef} />
        <GanttTimeline
          tasks={svarTasks}
          links={svarLinks as never}
          zoom={zoomLevel}
          onApiReady={handleApiReady}
        />
      </div>

      {/* Monte Carlo confidence row — hidden on mobile (< md) */}
      <MonteCarloRow ganttApi={ganttApi} />
    </div>
  );
}
