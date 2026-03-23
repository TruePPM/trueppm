import { useRef, useCallback } from 'react';
import { Gantt } from '@svar-ui/react-gantt';
import type { IApi, ITask, IZoomConfig } from '@svar-ui/gantt-store';
import type { ZoomLevel } from '@/types';
import { useSvarScale } from '@/hooks/useSvarScale';
import { PreviewOverlay } from './PreviewOverlay';

// SVAR zoom configuration per level (IZoomConfig with IScaleLevel scales)
const ZOOM_CONFIGS: Record<ZoomLevel, IZoomConfig> = {
  day: {
    levels: [
      {
        minCellWidth: 40,
        maxCellWidth: 120,
        scales: [
          { unit: 'month', step: 1, format: '%M %Y' },
          { unit: 'day', step: 1, format: '%d' },
        ],
      },
    ],
  },
  week: {
    levels: [
      {
        minCellWidth: 60,
        maxCellWidth: 200,
        scales: [
          { unit: 'month', step: 1, format: '%M %Y' },
          { unit: 'week', step: 1, format: 'W%W' },
        ],
      },
    ],
  },
  month: {
    levels: [
      {
        minCellWidth: 60,
        maxCellWidth: 200,
        scales: [
          { unit: 'year', step: 1, format: '%Y' },
          { unit: 'month', step: 1, format: '%M' },
        ],
      },
    ],
  },
  quarter: {
    levels: [
      {
        minCellWidth: 80,
        maxCellWidth: 300,
        scales: [
          { unit: 'year', step: 1, format: '%Y' },
          { unit: 'quarter', step: 1, format: 'Q%q' },
        ],
      },
    ],
  },
};

interface Props {
  tasks: ITask[];
  links: ITask[];
  zoom: ZoomLevel;
  onApiReady: (api: IApi) => void;
  /** Ordered task ids as rendered — passed to PreviewOverlay for row-index lookup. */
  taskIds: string[];
}

export function GanttTimeline({ tasks, links, zoom, onApiReady, taskIds }: Props) {
  const apiRef = useRef<IApi | null>(null);
  const { scales, scrollLeft } = useSvarScale(apiRef.current);

  const handleInit = useCallback(
    (api: IApi) => {
      apiRef.current = api;
      onApiReady(api);
    },
    [onApiReady],
  );

  return (
    <div className="gantt-root flex-1 min-w-0 overflow-hidden h-full relative">
      <Gantt
        tasks={tasks}
        links={links as never}
        zoom={ZOOM_CONFIGS[zoom]}
        init={handleInit}
      />
      <PreviewOverlay
        scales={scales}
        scrollLeft={scrollLeft}
        taskIds={taskIds}
      />
    </div>
  );
}
