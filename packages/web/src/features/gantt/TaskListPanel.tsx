import { useRef, useEffect, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Task } from '@/types';
import { ROW_HEIGHT } from './ganttConstants';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import { useGanttStore } from '@/stores/ganttStore';
import { TaskListHeader } from './TaskListHeader';
import { TaskListRow } from './TaskListRow';

/** Derive WBS nesting level from the dot-separated wbs string (e.g. '1.2.3' → level 3) */
function wbsLevel(wbs: string): number {
  return wbs.split('.').length;
}

interface Props {
  tasks: Task[];
  scrollRef: RefObject<HTMLDivElement | null>;
  widths: ColumnWidths['widths'];
  setWidth: ColumnWidths['setWidth'];
  totalWidth: number;
}

export function TaskListPanel({ tasks, scrollRef, widths, setWidth, totalWidth }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollToTaskId = useGanttStore((s) => s.scrollToTaskId);
  const scrollToTask = useGanttStore((s) => s.scrollToTask);

  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  // Scroll-to-task: triggered by badge popover navigation (issue #32)
  useEffect(() => {
    if (!scrollToTaskId) return;
    const idx = tasks.findIndex((t) => t.id === scrollToTaskId);
    if (idx !== -1) virtualizer.scrollToIndex(idx, { align: 'center' });
    scrollToTask(null);
  }, [scrollToTaskId, tasks, virtualizer, scrollToTask]);

  const items = virtualizer.getVirtualItems();

  return (
    <div
      style={{ width: totalWidth }}
      className="flex flex-col flex-shrink-0 border-r border-neutral-border/30 h-full bg-gantt-surface"
      role="grid"
      aria-label="Task list"
      aria-rowcount={tasks.length}
    >
      <TaskListHeader widths={widths} setWidth={setWidth} />

      {/* Scrollable virtualized rows */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden"
        style={{ contain: 'strict' }}
      >
        <div
          ref={containerRef}
          style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
        >
          {items.map((virtualRow) => {
            const task = tasks[virtualRow.index];
            return (
              <div
                key={virtualRow.key}
                style={{
                  position: 'absolute',
                  top: virtualRow.start,
                  left: 0,
                  right: 0,
                  height: ROW_HEIGHT,
                }}
              >
                <TaskListRow task={task} level={wbsLevel(task.wbs)} widths={widths} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
