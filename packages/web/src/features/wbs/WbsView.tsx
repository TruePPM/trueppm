import { useEffect, useCallback, useState, useMemo, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask, useReorderTasks, useIndentTask, useOutdentTask, useReparentTask } from '@/hooks/useTaskMutations';
import { useWbsStore } from '@/stores/wbsStore';
import { buildWbsTree, flattenVisible, collectAllIds } from './buildWbsTree';
import { WbsRow } from './WbsRow';
import { TaskFormModal } from '@/features/board/TaskFormModal';
import { formatPredecessors } from './formatPredecessor';
import type { Task } from '@/types';

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function WbsEmptyState() {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-3 bg-neutral-surface"
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
      <p className="text-sm text-neutral-text-primary font-medium">No tasks yet</p>
      <p className="text-xs text-neutral-text-secondary text-center max-w-xs">
        Add your first task to build your work breakdown structure.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WbsView
// ---------------------------------------------------------------------------

export function WbsView() {
  const projectId = useProjectId() ?? null;
  const { tasks, links, isLoading, error } = useScheduleTasks();

  // Build predecessor display strings keyed by task id.
  const predecessorTextById = useMemo(() => {
    if (!tasks || !links) return new Map<string, string>();
    const wbsById = new Map(tasks.map((t) => [t.id, t.wbs]));
    // Group incoming links by successor id
    const bySuccessor = new Map<string, typeof links>();
    for (const link of links) {
      const list = bySuccessor.get(link.targetId) ?? [];
      list.push(link);
      bySuccessor.set(link.targetId, list);
    }
    const result = new Map<string, string>();
    for (const task of tasks) {
      const incoming = bySuccessor.get(task.id) ?? [];
      const preds = incoming.map((l) => ({
        wbs: wbsById.get(l.sourceId) ?? '?',
        type: l.type,
        lagDays: l.lag,
      }));
      result.set(task.id, formatPredecessors(preds));
    }
    return result;
  }, [tasks, links]);
  const { expandedIds, toggle, expandAll, collapseAll, selectedTaskId, setSelectedTaskId } = useWbsStore();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  // Mobile breakpoint detection for the unified task form modal — same
  // pattern as BoardView's useBoardDensity (matchMedia at < md / 768px).
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  // When set, the add-form creates a child under this task id rather than at root.
  const [addFormParentId, setAddFormParentId] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const updateTask = useUpdateTask();
  const reorderTasks = useReorderTasks(projectId);
  const indentTask = useIndentTask(projectId);
  const outdentTask = useOutdentTask(projectId);
  const reparentTask = useReparentTask(projectId);
  const [reparentTargetId, setReparentTargetId] = useState<string | null>(null);

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

  // Track reparent drop target during drag — announces via aria-live on transition.
  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over || !tasks) {
        if (reparentTargetId !== null) setReparentTargetId(null);
        return;
      }
      const activeTask = tasks.find((t) => t.id === active.id);
      const overTask = tasks.find((t) => t.id === over.id);
      const isReparent =
        activeTask &&
        overTask &&
        overTask.isSummary &&
        overTask.id !== activeTask.id &&
        overTask.id !== activeTask.parentId;
      const nextTargetId = isReparent ? overTask.id : null;
      if (nextTargetId !== reparentTargetId) {
        setReparentTargetId(nextTargetId);
        if (nextTargetId && activeTask && overTask) {
          setLiveAnnouncement(`${activeTask.name} will become child of ${overTask.name}`);
        }
      }
    },
    [tasks, reparentTargetId],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setReparentTargetId(null);
      const { active, over } = event;
      if (!over || active.id === over.id || !tasks) return;

      const activeTask = tasks.find((t) => t.id === active.id);
      const overTask = tasks.find((t) => t.id === over.id);
      if (!activeTask || !overTask) return;

      // Drop onto a summary re-parents the task — unless it's already that parent.
      if (overTask.isSummary && overTask.id !== activeTask.parentId) {
        if (!projectId) return;
        reparentTask.mutate(
          { taskId: activeTask.id, newParentId: overTask.id },
          {
            onSuccess: (data) => {
              const warning = data.warning === 'has_assignments'
                ? ' — warning: new parent had resource assignments'
                : '';
              setLiveAnnouncement(
                `${activeTask.name} moved under ${overTask.name}${warning}`,
              );
            },
            onError: () =>
              setLiveAnnouncement(`Couldn't move ${activeTask.name} under ${overTask.name}`),
          },
        );
        return;
      }

      if (activeTask.parentId !== overTask.parentId) return;

      // Get the sibling list for this parent
      const siblings = tasks
        .filter((t) => t.parentId === activeTask.parentId)
        .sort((a, b) => {
          const aParts = (a.wbs || '0').split('.').map(Number);
          const bParts = (b.wbs || '0').split('.').map(Number);
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

      // Derive parent_path: the wbs_path of the parent task, or "" for root
      const parentTask = activeTask.parentId ? tasks.find((t) => t.id === activeTask.parentId) : null;
      const parent_path = parentTask?.wbs ?? '';

      if (projectId) {
        reorderTasks.mutate({
          parent_path,
          ordered_ids: reordered.map((t) => t.id),
        });
      }
    },
    [tasks, projectId, reorderTasks, reparentTask],
  );

  const handleRename = useCallback(
    (task: Task, newName: string) => {
      setRenamingId(null);
      if (newName.trim() === '' || newName === task.name) return;
      if (projectId) {
        updateTask.mutate({ id: task.id, projectId, name: newName.trim() });
      }
    },
    [projectId, updateTask],
  );

  // Keyboard shortcuts: Tab=indent, Shift+Tab=outdent, Alt+Up/Down=reorder, Up/Down=navigate
  const handleTreeKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!tasks || renamingId) return;

      const tree = buildWbsTree(tasks);
      const visible = flattenVisible(tree, expandedIds);
      const currentIdx = visible.findIndex((n) => n.task.id === selectedTaskId);

      // Tab = indent, Shift+Tab = outdent
      if (e.key === 'Tab') {
        e.preventDefault();
        if (!selectedTaskId) return;
        if (e.shiftKey) {
          // Outdent
          outdentTask.mutate(selectedTaskId, {
            onSuccess: (data) => {
              const warning = data.warning === 'has_assignments'
                ? ' — warning: task had resource assignments'
                : '';
              setLiveAnnouncement(`Task outdented${warning}`);
            },
            onError: () => setLiveAnnouncement('Cannot outdent: task is already at root level'),
          });
        } else {
          // Indent
          indentTask.mutate(selectedTaskId, {
            onSuccess: (data) => {
              const warning = data.warning === 'has_assignments'
                ? ' — warning: parent task had resource assignments'
                : '';
              setLiveAnnouncement(`Task indented${warning}`);
            },
            onError: () => setLiveAnnouncement('Cannot indent: no previous sibling to become parent'),
          });
        }
        return;
      }

      // Alt+Up/Down = reorder within siblings
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
        e.preventDefault();
        if (!selectedTaskId || currentIdx === -1) return;
        const currentTask = visible[currentIdx].task;
        const siblings = tasks
          .filter((t) => t.parentId === currentTask.parentId)
          .sort((a, b) => {
            const aParts = (a.wbs || '0').split('.').map(Number);
            const bParts = (b.wbs || '0').split('.').map(Number);
            for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
              const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
              if (diff !== 0) return diff;
            }
            return 0;
          });
        const sibIdx = siblings.findIndex((t) => t.id === selectedTaskId);
        const newIdx = e.key === 'ArrowUp' ? sibIdx - 1 : sibIdx + 1;
        if (newIdx < 0 || newIdx >= siblings.length) return;

        const reordered = [...siblings];
        reordered.splice(sibIdx, 1);
        reordered.splice(newIdx, 0, currentTask);

        const parentTask = currentTask.parentId
          ? tasks.find((t) => t.id === currentTask.parentId)
          : null;
        const parent_path = parentTask?.wbs ?? '';

        if (projectId) {
          reorderTasks.mutate(
            { parent_path, ordered_ids: reordered.map((t) => t.id) },
            { onSuccess: () => setLiveAnnouncement(`${currentTask.name} moved ${e.key === 'ArrowUp' ? 'up' : 'down'}`) },
          );
        }
        return;
      }

      // Up/Down = navigate rows
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const newIdx = e.key === 'ArrowUp'
          ? Math.max(0, currentIdx - 1)
          : Math.min(visible.length - 1, currentIdx + 1);
        const newTask = visible[newIdx];
        if (newTask) {
          setSelectedTaskId(newTask.task.id);
          const row = document.querySelector<HTMLElement>(`[data-task-id="${newTask.task.id}"]`);
          row?.focus();
        }
        return;
      }
    },
    [tasks, renamingId, expandedIds, selectedTaskId, setSelectedTaskId, projectId,
      indentTask, outdentTask, reorderTasks, setLiveAnnouncement],
  );

  const handleExpandAll = useCallback(() => {
    if (!tasks) return;
    const tree = buildWbsTree(tasks);
    expandAll(collectAllIds(tree));
  }, [tasks, expandAll]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-surface">
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
      <div className="flex h-full flex-col bg-neutral-surface p-3 gap-1" aria-busy="true">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-11 rounded animate-pulse bg-neutral-surface-sunken"
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
    <div className="flex flex-col h-full bg-neutral-surface overflow-hidden">
      {/* Toolbar row */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-neutral-border flex-shrink-0">
        {projectId && (
          <>
            <button
              type="button"
              onClick={() => { setAddFormParentId(null); setShowAddForm(true); }}
              aria-label="Add root-level task"
              className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
                focus-visible:ring-1 focus-visible:ring-brand-primary focus-visible:outline-none px-1"
            >
              + Task
            </button>
            {selectedTaskId && (
              <button
                type="button"
                onClick={() => { setAddFormParentId(selectedTaskId); setShowAddForm(true); }}
                aria-label="Add child task under selected"
                className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
                  focus-visible:ring-1 focus-visible:ring-brand-primary focus-visible:outline-none px-1"
              >
                + Child
              </button>
            )}
          </>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleExpandAll}
          className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
            focus-visible:ring-1 focus-visible:ring-brand-primary focus-visible:outline-none px-1"
          aria-label="Expand all"
        >
          + All
        </button>
        <button
          type="button"
          onClick={collapseAll}
          className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
            focus-visible:ring-1 focus-visible:ring-brand-primary focus-visible:outline-none px-1"
          aria-label="Collapse all"
        >
          − All
        </button>
      </div>

      {/* Task creation modal — replaces the inline AddTaskForm strip
          (issue #305 / ADR-0052). Always opens in create mode here. */}
      {showAddForm && projectId && (
        <TaskFormModal
          projectId={projectId}
          task={null}
          parentId={addFormParentId ?? undefined}
          isMobile={isMobile}
          onClose={() => {
            setShowAddForm(false);
            setAddFormParentId(null);
          }}
        />
      )}

      {/* Column headers */}
      <div
        className="flex items-center h-9 border-b border-neutral-border px-2 flex-shrink-0
          bg-neutral-surface-sunken tppm-mono text-xs font-semibold tracking-widest uppercase
          text-neutral-text-secondary"
        aria-hidden="true"
      >
        <span className="w-4 flex-shrink-0" /> {/* drag handle */}
        <span className="w-4 flex-shrink-0" /> {/* expand toggle */}
        <span className="w-14 flex-shrink-0 text-right pr-3">WBS</span>
        <span className="flex-1 min-w-0">Name</span>
        <span className="w-12 flex-shrink-0 text-center">Owner</span>
        <span className="w-24 flex-shrink-0 pr-2">% Done</span>
        <span className="w-20 flex-shrink-0 text-right pr-2">Start</span>
        <span className="w-20 flex-shrink-0 text-right pr-2">Finish</span>
        <span className="w-10 flex-shrink-0 text-right">Dur</span>
        <span className="w-36 flex-shrink-0 pl-2">Predecessors</span>
      </div>

      {/* Tree */}
      {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- roving tabindex on rows */}
      <div
        role="treegrid"
        aria-label="WBS task tree"
        className="flex-1 overflow-y-auto"
        onKeyDown={handleTreeKeyDown}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setReparentTargetId(null)}
        >
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            {visible.map((node) => (
              <WbsRow
                key={node.task.id}
                node={node}
                isExpanded={expandedIds.has(node.task.id)}
                isRenaming={renamingId === node.task.id}
                isSelected={selectedTaskId === node.task.id}
                isReparentTarget={reparentTargetId === node.task.id}
                predecessorText={predecessorTextById.get(node.task.id) ?? ''}
                onToggle={() => toggle(node.task.id)}
                onSelect={() => setSelectedTaskId(node.task.id)}
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
