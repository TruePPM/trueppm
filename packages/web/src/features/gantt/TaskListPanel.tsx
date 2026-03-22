import { useRef, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Task } from '@/types';
import { ROW_HEIGHT, TASK_LIST_WIDTH } from './ganttConstants';
import { TaskListHeader } from './TaskListHeader';
import { TaskListRow } from './TaskListRow';

/** Derive WBS nesting level from the dot-separated wbs string (e.g. '1.2.3' → level 3) */
function wbsLevel(wbs: string): number {
  return wbs.split('.').length;
}

interface Props {
  tasks: Task[];
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function TaskListPanel({ tasks, scrollRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div
      style={{ width: TASK_LIST_WIDTH }}
      className="flex flex-col flex-shrink-0 border-r border-neutral-border h-full"
      role="grid"
      aria-label="Task list"
      aria-rowcount={tasks.length}
    >
      <TaskListHeader />

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
                <TaskListRow task={task} level={wbsLevel(task.wbs)} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
