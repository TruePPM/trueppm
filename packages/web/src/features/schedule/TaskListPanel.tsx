import { useRef, useState, useEffect, useMemo, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Task } from '@/types';
import { ROW_HEIGHT } from './scheduleConstants';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import { useScheduleStore } from '@/stores/scheduleStore';
import { TaskListHeader } from './TaskListHeader';
import { TaskListRow } from './TaskListRow';

/** Derive WBS nesting level from the dot-separated wbs string (e.g. '1.2.3' → level 3) */
function wbsLevel(wbs: string): number {
  return wbs.split('.').length;
}

/** WBS parent path: '1.2.3' → '1.2', '1' → '' */
function wbsParent(wbs: string): string {
  const parts = wbs.split('.');
  return parts.slice(0, -1).join('.');
}

/** All same-level siblings of a task (tasks with matching parent wbs path). */
function computeSiblingIds(task: Task, allTasks: Task[]): string[] {
  const parentPath = wbsParent(task.wbs);
  const level = wbsLevel(task.wbs);
  return allTasks
    .filter((t) => wbsLevel(t.wbs) === level && wbsParent(t.wbs) === parentPath)
    .map((t) => t.id);
}

/** Ancestor summary tasks for a milestone, closest first (up to 3 levels). */
function computeMilestoneParents(
  task: Task,
  allTasks: Task[],
): { name: string; finish?: string }[] {
  const wbsByTask = new Map(allTasks.map((t) => [t.wbs, t]));
  const parts = task.wbs.split('.');
  const parents: { name: string; finish?: string }[] = [];
  for (let i = parts.length - 1; i >= 1; i--) {
    const parentWbs = parts.slice(0, i).join('.');
    const parent = wbsByTask.get(parentWbs);
    if (parent) parents.push({ name: parent.name, finish: parent.finish || undefined });
  }
  return parents.slice(0, 3);
}

/** Deduplicated task name list: milestones first, then all others. */
function computeNameSuggestions(tasks: Task[]): string[] {
  const milestoneNames = tasks.filter((t) => t.isMilestone).map((t) => t.name);
  const otherNames = tasks.filter((t) => !t.isMilestone).map((t) => t.name);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of [...milestoneNames, ...otherNames]) {
    if (!seen.has(name)) { seen.add(name); result.push(name); }
  }
  return result;
}

// ---------------------------------------------------------------------------
// PendingTaskRow — shown for tasks created but not yet scheduled (no dates yet)
// ---------------------------------------------------------------------------

function PendingTaskRow({ name }: { name: string }) {
  const [timedOut, setTimedOut] = useState(false);

  // After 8 s without the scheduler responding, swap spinner for a "Pending" label
  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 8000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      role="row"
      aria-label={`${name}, pending scheduling`}
      className="flex items-center h-[28px] px-2 gap-1 border-b border-neutral-800/50
        bg-white/5 border-l-2 border-brand-primary/40"
      style={{ height: ROW_HEIGHT }}
    >
      {/* Empty checkbox column */}
      <span className="w-6 flex-shrink-0" />
      {/* WBS placeholder */}
      <span className="w-8 flex-shrink-0 text-xs font-mono text-neutral-text-disabled text-right pr-1">—</span>
      {/* Name */}
      <span className="flex-1 min-w-0 text-xs text-neutral-text-secondary italic truncate pr-2">
        {name}
      </span>
      {/* Scheduling indicator */}
      <span className="flex items-center gap-1 flex-shrink-0 text-xs text-neutral-text-secondary pr-1">
        {timedOut ? (
          <span className="text-semantic-at-risk">Pending schedule</span>
        ) : (
          <>
            <span
              role="status"
              aria-label="Scheduling in progress"
              className="inline-block w-2.5 h-2.5 rounded-full border-2 border-current border-t-transparent animate-spin"
            />
            Scheduling…
          </>
        )}
      </span>
    </div>
  );
}

/** Per-task dep-chip data — computed in ScheduleView, passed down for focus mode. */
export interface TaskDepChips {
  predsCount: number;
  succsCount: number;
  predsCritical: boolean;
  succsCritical: boolean;
}

interface Props {
  tasks: Task[];
  /** Map of taskId → taskName for tasks pending scheduler assignment. */
  pendingTaskIds?: Map<string, string>;
  scrollRef: RefObject<HTMLDivElement | null>;
  widths: ColumnWidths['widths'];
  visible: ColumnWidths['visible'];
  setWidth: ColumnWidths['setWidth'];
  totalWidth: number;
  /** Set of task IDs that have children (are summary tasks). */
  summaryIds: Set<string>;
  /** Set of expanded task IDs for collapse/expand. */
  expandedIds: Set<string>;
  /** Toggle expand/collapse for a task. */
  onToggle: (id: string) => void;
  /**
   * When non-empty, tasks NOT in this set are dimmed to 22% (focus mode).
   * An empty/undefined set means focus mode is off.
   */
  focusChainIds?: Set<string>;
  /**
   * Per-task dep-chip data — shown on the selected task row when focus mode is on.
   */
  depChipsById?: Map<string, TaskDepChips>;
}

export function TaskListPanel({ tasks, pendingTaskIds, scrollRef, widths, visible, setWidth, totalWidth, summaryIds, expandedIds, onToggle, focusChainIds, depChipsById }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollToTaskId = useScheduleStore((s) => s.scrollToTaskId);
  const scrollToTask = useScheduleStore((s) => s.scrollToTask);

  // Derived maps computed once per tasks change — passed to each row for #343/#345/#347
  const siblingIdsMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const task of tasks) map.set(task.id, computeSiblingIds(task, tasks));
    return map;
  }, [tasks]);

  const nameSuggestions = useMemo(() => computeNameSuggestions(tasks), [tasks]);

  const milestoneParentsMap = useMemo(() => {
    const map = new Map<string, { name: string; finish?: string }[]>();
    for (const task of tasks) {
      if (task.isMilestone) map.set(task.id, computeMilestoneParents(task, tasks));
    }
    return map;
  }, [tasks]);

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
      className="flex flex-col flex-shrink-0 border-r border-neutral-border h-full bg-neutral-surface"
      role="grid"
      aria-label="Task list"
      aria-rowcount={tasks.length}
    >
      <TaskListHeader widths={widths} visible={visible} setWidth={setWidth} />

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
                <TaskListRow
                  task={task}
                  level={wbsLevel(task.wbs)}
                  widths={widths}
                  visible={visible}
                  hasChildren={summaryIds.has(task.id)}
                  isExpanded={expandedIds.has(task.id)}
                  onToggle={() => onToggle(task.id)}
                  prevTaskId={virtualRow.index > 0 ? tasks[virtualRow.index - 1].id : null}
                  nextTaskId={virtualRow.index < tasks.length - 1 ? tasks[virtualRow.index + 1].id : null}
                  dimmed={focusChainIds !== undefined && focusChainIds.size > 0 && !focusChainIds.has(task.id)}
                  depChips={depChipsById?.get(task.id)}
                  siblingIds={siblingIdsMap.get(task.id)}
                  nameSuggestions={nameSuggestions}
                  milestoneParents={milestoneParentsMap.get(task.id)}
                />
              </div>
            );
          })}
        </div>

        {/* Pending rows — non-virtualised; appear below scheduled tasks until CPM runs */}
        {pendingTaskIds && pendingTaskIds.size > 0 && (
          <div>
            {Array.from(pendingTaskIds.entries()).map(([id, name]) => (
              <PendingTaskRow key={id} name={name} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
