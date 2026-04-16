import { useState, useRef, useCallback, useMemo } from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
} from '@dnd-kit/core';
import { useGanttTasks } from '@/hooks/useGanttTasks';
import { useUpdateTaskStatus } from '@/hooks/useBoardTasks';
import { useBoardConfig } from '@/hooks/useBoardConfig';
import type { Task, TaskStatus } from '@/types';
import { BoardColumn } from './BoardColumn';
import { BoardCard } from './BoardCard';

export function BoardView() {
  const projectId = useProjectId() ?? '';
  const { columns: COLUMNS } = useBoardConfig(projectId || null);
  const { tasks, isLoading } = useGanttTasks();
  const updateStatus = useUpdateTaskStatus();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<TaskStatus | null>(null);
  const ariaLiveRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  const tasksByStatus = useMemo(() => {
    const grouped: Record<TaskStatus, Task[]> = {
      NOT_STARTED: [],
      IN_PROGRESS: [],
      ON_HOLD: [],
      COMPLETE: [],
    };
    if (!tasks) return grouped;
    for (const task of tasks) {
      // Summary tasks don't appear on the board — they aggregate children
      if (task.isSummary) continue;
      const bucket = grouped[task.status];
      if (bucket) bucket.push(task);
    }
    return grouped;
  }, [tasks]);

  const activeTask = useMemo(
    () => (activeId ? tasks?.find((t) => t.id === activeId) ?? null : null),
    [activeId, tasks],
  );

  const sourceColumn = activeTask?.status ?? null;

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const overId = event.over?.id;
      if (!overId) {
        setOverColumn(null);
        return;
      }
      // Over IDs are column status strings
      const col = String(overId) as TaskStatus;
      // Don't highlight source column (rule 103)
      if (col === sourceColumn) {
        setOverColumn(null);
      } else {
        setOverColumn(col);
      }
    },
    [sourceColumn],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const overId = event.over?.id;
      setActiveId(null);
      setOverColumn(null);

      if (!overId || !activeTask) return;

      const newStatus = String(overId) as TaskStatus;
      if (newStatus === activeTask.status) return;

      updateStatus.mutate({ projectId, taskId: activeTask.id, status: newStatus });

      if (ariaLiveRef.current) {
        const colLabel = COLUMNS.find((c) => c.status === newStatus)?.label ?? newStatus;
        ariaLiveRef.current.textContent = `${activeTask.name} moved to ${colLabel}`;
      }
    },
    [activeTask, projectId, updateStatus],
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOverColumn(null);
  }, []);

  const handleMenuMove = useCallback(
    (task: Task, newStatus: TaskStatus) => {
      updateStatus.mutate({ projectId, taskId: task.id, status: newStatus });
      if (ariaLiveRef.current) {
        const colLabel = COLUMNS.find((c) => c.status === newStatus)?.label ?? newStatus;
        ariaLiveRef.current.textContent = `${task.name} moved to ${colLabel}`;
      }
    },
    [projectId, updateStatus],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-text-secondary text-sm">
        Loading board...
      </div>
    );
  }

  if (!tasks || tasks.length === 0) {
    return (
      <div
        className="flex items-center justify-center h-full text-neutral-text-secondary text-sm"
        role="status"
      >
        No tasks yet. Create tasks to see them on the board.
      </div>
    );
  }

  return (
    <>
      {/* aria-live region for status change announcements (rule 105) */}
      <div ref={ariaLiveRef} aria-live="polite" className="sr-only" />

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {/* Mobile: horizontal snap scroll (rule 104); Desktop: flex row */}
        <div
          className="flex h-full overflow-x-auto snap-x snap-mandatory md:snap-none
            gap-4 p-4"
        >
          {COLUMNS.map((col) => (
            <BoardColumn
              key={col.status}
              status={col.status}
              label={col.label}
              tasks={tasksByStatus[col.status]}
              isOver={overColumn === col.status}
              isDragActive={activeId !== null}
              onMenuMove={handleMenuMove}
            />
          ))}
        </div>

        {/* Drag overlay — floating card follows the pointer */}
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <BoardCard
              task={activeTask}
              isOverlay
              onMenuMove={() => {}}
              columns={COLUMNS}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Mobile FAB — creates task in currently visible column (rule 104) */}
      <button
        type="button"
        className="fixed bottom-16 right-4 w-14 h-14 rounded-full bg-brand-primary
          border border-brand-primary-dark text-white flex items-center justify-center
          text-2xl font-light md:hidden z-10
          focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2
          focus-visible:ring-offset-brand-primary"
        aria-label="Add task"
      >
        +
      </button>
    </>
  );
}
