import { useEffect, useCallback, useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { useGanttTasks } from '@/hooks/useGanttTasks';
import { useWbsStore } from '@/stores/wbsStore';
import { buildWbsTree, flattenVisible, collectAllIds } from './buildWbsTree';
import { WbsRow } from './WbsRow';
import type { Task } from '@/types';

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function WbsEmptyState() {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-3 bg-gantt-surface"
    >
      <svg
        aria-hidden="true"
        className="w-12 h-12 text-neutral-border"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M3 7h4m0 0V5m0 2v2m4-2h10M3 12h4m0 0v-2m0 2v2m4-2h10M3 17h4m0 0v-2m0 2v2m4-2h10"
        />
      </svg>
      <p className="text-sm text-gantt-text-primary font-medium">No tasks yet</p>
      <p className="text-xs text-gantt-text-secondary text-center max-w-xs">
        Add your first task to build your work breakdown structure.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WbsView
// ---------------------------------------------------------------------------

export function WbsView() {
  const { tasks, isLoading, error } = useGanttTasks();
  const { expandedIds, toggle, expandAll, collapseAll } = useWbsStore();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');

  // Expand all root-level summary nodes on first load
  useEffect(() => {
    if (!tasks) return;
    const tree = buildWbsTree(tasks);
    const summaryIds = tree.filter((n) => n.task.isSummary).map((n) => n.task.id);
    if (summaryIds.length > 0) {
      expandAll(summaryIds);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks?.length]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id || !tasks) return;

      const activeTask = tasks.find((t) => t.id === active.id);
      const overTask = tasks.find((t) => t.id === over.id);
      if (!activeTask || !overTask || activeTask.parentId !== overTask.parentId) return;

      // Get the sibling list for this parent
      const siblings = tasks
        .filter((t) => t.parentId === activeTask.parentId)
        .sort((a, b) => {
          const aParts = a.wbs.split('.').map(Number);
          const bParts = b.wbs.split('.').map(Number);
          for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
            const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
            if (diff !== 0) return diff;
          }
          return 0;
        });

      const oldIndex = siblings.findIndex((t) => t.id === active.id);
      const newIndex = siblings.findIndex((t) => t.id === over.id);
      if (oldIndex === newIndex) return;

      // Build new order
      const reordered = [...siblings];
      reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, activeTask);

      // Announce via live region
      setLiveAnnouncement(
        `${activeTask.name} moved to position ${newIndex + 1} under ${activeTask.parentId ? tasks.find((t) => t.id === activeTask.parentId)?.name ?? 'root' : 'root'}`,
      );

      // TODO: call POST /api/v1/projects/{id}/tasks/reorder/ when real API is wired
      void reordered;
    },
    [tasks],
  );

  const handleRename = useCallback(
    (task: Task, newName: string) => {
      setRenamingId(null);
      if (newName.trim() === '' || newName === task.name) return;
      // TODO: call PATCH /api/v1/tasks/{id}/ when real API is wired
    },
    [],
  );

  const handleExpandAll = useCallback(() => {
    if (!tasks) return;
    const tree = buildWbsTree(tasks);
    expandAll(collectAllIds(tree));
  }, [tasks, expandAll]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-gantt-surface">
        <p className="text-sm text-gantt-semantic-critical">
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
      <div className="flex h-full flex-col bg-gantt-surface p-3 gap-1" aria-busy="true">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-11 rounded animate-pulse bg-neutral-800/60"
            style={{ marginLeft: `${(i % 3) * 16}px` }}
          />
        ))}
      </div>
    );
  }

  if (tasks.length === 0) return <WbsEmptyState />;

  const tree = buildWbsTree(tasks);
  const visible = flattenVisible(tree, expandedIds);
  // Sortable IDs are all visible IDs (drag is within siblings only)
  const sortableIds = visible.map((n) => n.task.id);

  return (
    <div className="flex flex-col h-full bg-gantt-surface overflow-hidden">
      {/* Toolbar row */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-neutral-800 flex-shrink-0">
        <button
          type="button"
          onClick={handleExpandAll}
          className="text-xs text-gantt-text-secondary hover:text-gantt-text-primary
            focus-visible:ring-1 focus-visible:ring-brand-primary focus-visible:outline-none px-1"
          aria-label="Expand all"
        >
          + All
        </button>
        <button
          type="button"
          onClick={collapseAll}
          className="text-xs text-gantt-text-secondary hover:text-gantt-text-primary
            focus-visible:ring-1 focus-visible:ring-brand-primary focus-visible:outline-none px-1"
          aria-label="Collapse all"
        >
          − All
        </button>
      </div>

      {/* Column headers */}
      <div
        className="flex items-center h-8 border-b border-neutral-800 px-2 flex-shrink-0
          text-xs font-semibold tracking-wide uppercase text-gantt-text-secondary"
        aria-hidden="true"
      >
        <span className="w-5 flex-shrink-0" /> {/* drag handle col */}
        <span className="w-16 flex-shrink-0 text-right pr-3">WBS</span>
        <span className="flex-1 min-w-0">Name</span>
        <span className="w-20 flex-shrink-0 text-right pr-2">Progress</span>
        <span className="w-10 flex-shrink-0 text-right">Dur</span>
      </div>

      {/* Tree */}
      <div
        role="treegrid"
        aria-label="WBS task tree"
        className="flex-1 overflow-y-auto"
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            {visible.map((node) => (
              <WbsRow
                key={node.task.id}
                node={node}
                isExpanded={expandedIds.has(node.task.id)}
                isRenaming={renamingId === node.task.id}
                onToggle={() => toggle(node.task.id)}
                onStartRename={() => setRenamingId(node.task.id)}
                onRename={(name) => handleRename(node.task, name)}
                onCancelRename={() => setRenamingId(null)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {/* Accessible live region for drag announcements */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        aria-label={liveAnnouncement}
      />
    </div>
  );
}
