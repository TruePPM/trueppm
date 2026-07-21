import { useEffect, useCallback, useState, useMemo, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
import { useProjectId } from '@/hooks/useProjectId';
import { buildWbsTree, flattenVisible, collectAllIds } from './buildWbsTree';
import { OutlineRow } from './OutlineRow';
import { formatPredecessors } from './formatPredecessor';
import { GridFilteredEmptyState } from './GridEmptyState';
import { taskDndAnnouncements } from '@/lib/dndAnnouncements';
import type { Task } from '@/types';
import type { GridFilterState } from './filters';
import { matchesFilters, hasAnyFilter } from './filters';

interface OutlineModeProps {
  filters: GridFilterState;
  onClearFilters: () => void;
  /** Imperative trigger for "Expand all" — increments to force expand. */
  expandAllCounter: number;
  /** Imperative trigger for "Collapse all". */
  collapseAllCounter: number;
}

/**
 * Outline mode adapter — tree view with drag-to-reparent, indent/outdent,
 * and predecessors column. Mirrors the legacy `WbsView` body without its
 * toolbar (the shell now owns toolbar chrome).
 *
 * Filters applied: a task is visible if it matches OR has a matching
 * descendant. Ancestors of matches stay visible to preserve tree integrity.
 */
export function OutlineMode({
  filters, onClearFilters, expandAllCounter, collapseAllCounter,
}: OutlineModeProps) {
  const projectId = useProjectId() ?? null;
  const { tasks, links } = useScheduleTasks();

  const predecessorTextById = useMemo(() => {
    if (!tasks || !links) return new Map<string, string>();
    const wbsById = new Map(tasks.map((t) => [t.id, t.wbs]));
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
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const updateTask = useUpdateTask();
  const reorderTasks = useReorderTasks(projectId);
  const indentTask = useIndentTask(projectId);
  const outdentTask = useOutdentTask(projectId);
  const reparentTask = useReparentTask(projectId);
  const [reparentTargetId, setReparentTargetId] = useState<string | null>(null);

  // Name the dragged task on pickup/cancel instead of dnd-kit's raw-UUID
  // default (#2203); the semantic move outcome is announced via liveAnnouncement.
  const dndAnnouncements = useMemo(() => taskDndAnnouncements(tasks), [tasks]);

  // Filter tasks down to matches + their ancestors so the tree stays valid
  // even when a leaf matches but its parent doesn't.
  const visibleTasks = useMemo(() => {
    const base = tasks ?? [];
    if (!hasAnyFilter(filters)) return base;
    const byId = new Map(base.map((t) => [t.id, t]));
    const keep = new Set<string>();
    for (const task of base) {
      if (matchesFilters(task, filters)) {
        let current: Task | undefined = task;
        while (current) {
          if (keep.has(current.id)) break;
          keep.add(current.id);
          current = current.parentId ? byId.get(current.parentId) : undefined;
        }
      }
    }
    return base.filter((t) => keep.has(t.id));
  }, [tasks, filters]);

  // Expand all root-level summaries on first load.
  useEffect(() => {
    if (!tasks) return;
    const tree = buildWbsTree(tasks);
    const summaryIds = tree.filter((n) => n.task.isSummary).map((n) => n.task.id);
    if (summaryIds.length > 0) expandAll(summaryIds);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks?.length]);

  // Imperative expand-all / collapse-all from the toolbar.
  useEffect(() => {
    if (!tasks || expandAllCounter === 0) return;
    const tree = buildWbsTree(tasks);
    expandAll(collectAllIds(tree));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandAllCounter]);
  useEffect(() => {
    if (collapseAllCounter === 0) return;
    collapseAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseAllCounter]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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

      const reordered = [...siblings];
      reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, activeTask);

      setLiveAnnouncement(
        `${activeTask.name} moved to position ${newIndex + 1} under ${activeTask.parentId ? tasks.find((t) => t.id === activeTask.parentId)?.name ?? 'root' : 'root'}`,
      );

      const parentTask = activeTask.parentId ? tasks.find((t) => t.id === activeTask.parentId) : null;
      const parent_path = parentTask?.wbs ?? '';

      if (projectId) {
        reorderTasks.mutate({ parent_path, ordered_ids: reordered.map((t) => t.id) });
      }
    },
    [tasks, projectId, reorderTasks, reparentTask],
  );

  const handleRename = useCallback(
    (task: Task, newName: string) => {
      setRenamingId(null);
      if (newName.trim() === '' || newName === task.name) return;
      if (projectId) updateTask.mutate({ id: task.id, projectId, name: newName.trim() });
    },
    [projectId, updateTask],
  );

  const handleTreeKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!tasks || renamingId) return;

      const tree = buildWbsTree(visibleTasks);
      const visible = flattenVisible(tree, expandedIds);
      const currentIdx = visible.findIndex((n) => n.task.id === selectedTaskId);

      // Indent/outdent are bound to Alt+ArrowRight / Alt+ArrowLeft (mirroring the
      // Alt+ArrowUp/Down move bindings below), NOT Tab. Binding these to Tab created
      // a WCAG 2.1.2 keyboard trap — every Tab was intercepted and preventDefault'd,
      // so a keyboard user could never leave the treegrid, and each escape attempt
      // fired a WBS mutation (#2192). Plain Tab now falls through untouched.
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.altKey) {
        e.preventDefault();
        if (!selectedTaskId) return;
        if (e.key === 'ArrowLeft') {
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
    [tasks, visibleTasks, renamingId, expandedIds, selectedTaskId, setSelectedTaskId, projectId,
      indentTask, outdentTask, reorderTasks, setLiveAnnouncement],
  );

  if (visibleTasks.length === 0 && hasAnyFilter(filters)) {
    return <GridFilteredEmptyState onClear={onClearFilters} />;
  }

  const tree = buildWbsTree(visibleTasks);
  const visible = flattenVisible(tree, expandedIds);
  const sortableIds = visible.map((n) => n.task.id);

  return (
    <>
      <div
        className="hidden md:flex items-center h-9 border-b border-neutral-border px-2 flex-shrink-0
          bg-neutral-surface-sunken tppm-mono text-xs font-semibold tracking-widest uppercase
          text-neutral-text-secondary"
        aria-hidden="true"
      >
        <span className="w-4 flex-shrink-0" />
        <span className="w-4 flex-shrink-0" />
        <span className="w-14 flex-shrink-0 text-right pr-3">WBS</span>
        <span className="flex-1 min-w-0">Name</span>
        <span className="w-12 flex-shrink-0 text-center">Owner</span>
        <span className="w-24 flex-shrink-0 pr-2">% Done</span>
        <span className="w-20 flex-shrink-0 text-right pr-2">Start</span>
        <span className="w-20 flex-shrink-0 text-right pr-2">Finish</span>
        <span className="w-10 flex-shrink-0 text-right">Dur</span>
        <span className="w-36 flex-shrink-0 pl-2">Predecessors</span>
      </div>

      <p id="outline-tree-keys" className="sr-only">
        Use up and down arrows to move between tasks. Hold Alt with the arrow keys to
        reorganize the selected task: Alt plus Right indents it, Alt plus Left outdents it,
        Alt plus Up or Down moves it among its siblings.
      </p>
      {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- roving tabindex on rows */}
      <div
        role="treegrid"
        aria-label="Outline task tree"
        aria-describedby="outline-tree-keys"
        className="flex-1 overflow-y-auto"
        onKeyDown={handleTreeKeyDown}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={{ announcements: dndAnnouncements }}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setReparentTargetId(null)}
        >
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            {visible.map((node) => (
              <OutlineRow
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

      {/* Render the message as text content, not an aria-label: aria-label
          mutations on an empty live node are not reliably spoken (#2203).
          Matches the working pattern in GridView. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {liveAnnouncement}
      </div>
    </>
  );
}
