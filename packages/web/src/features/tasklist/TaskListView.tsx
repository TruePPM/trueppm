import { useRef, useState, useCallback, useEffect, type RefObject, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useGanttTasks } from '@/hooks/useGanttTasks';
import { useUpdateTask, useBulkDeleteTasks } from '@/hooks/useTaskMutations';
import { useTaskSelectionStore } from '@/stores/taskSelectionStore';
import type { Task } from '@/types';

// ---------------------------------------------------------------------------
// Sort helpers
// ---------------------------------------------------------------------------

type SortCol = 'wbs' | 'name' | 'start' | 'finish' | 'duration' | 'progress';
type SortDir = 'asc' | 'desc';

function compareWbs(a: string, b: string): number {
  const ap = a.split('.').map(Number);
  const bp = b.split('.').map(Number);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const diff = (ap[i] ?? 0) - (bp[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function sortTasks(tasks: Task[], col: SortCol, dir: SortDir): Task[] {
  return [...tasks].sort((a, b) => {
    let cmp = 0;
    if (col === 'wbs') cmp = compareWbs(a.wbs, b.wbs);
    else if (col === 'name') cmp = a.name.localeCompare(b.name);
    else if (col === 'start') cmp = a.start.localeCompare(b.start);
    else if (col === 'finish') cmp = a.finish.localeCompare(b.finish);
    else if (col === 'duration') cmp = a.duration - b.duration;
    else if (col === 'progress') cmp = a.progress - b.progress;
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ---------------------------------------------------------------------------
// Column layout (fixed widths except Name which is flex-1)
// ---------------------------------------------------------------------------

const COL_CHECKBOX = 'w-10 flex-shrink-0';
const COL_WBS = 'w-14 flex-shrink-0';
const COL_START = 'w-24 flex-shrink-0';
const COL_FINISH = 'w-24 flex-shrink-0';
const COL_DURATION = 'w-14 flex-shrink-0';
const COL_PROGRESS = 'w-20 flex-shrink-0';
const COL_CP = 'w-12 flex-shrink-0';

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function TaskListEmptyState() {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-3 bg-gantt-surface"
    >
      <p className="text-sm text-gantt-text-primary font-medium">No tasks yet</p>
      <p className="text-xs text-gantt-text-secondary">
        Add tasks in the Gantt view to get started.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

interface TaskRowProps {
  task: Task;
  isSelected: boolean;
  isRenaming: boolean;
  onToggleSelect: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}

function TaskRow({
  task,
  isSelected,
  isRenaming,
  onToggleSelect,
  onStartRename,
  onRename,
  onCancelRename,
}: TaskRowProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onRename(e.currentTarget.value);
    else if (e.key === 'Escape') onCancelRename();
  };

  const handleRowKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'F2') {
      e.preventDefault();
      onStartRename();
    }
  };

  const rowBg = task.isCritical
    ? 'bg-red-950/30 border-l-2 border-gantt-semantic-critical'
    : isSelected
    ? 'bg-white/10 border-l-2 border-brand-primary'
    : 'border-l-2 border-transparent';

  return (
    <div
      role="row"
      aria-selected={isSelected}
      tabIndex={0}
      onKeyDown={handleRowKeyDown}
      onDoubleClick={task.isSummary ? undefined : onStartRename}
      className={`
        flex items-center h-11 px-2 gap-1
        border-b border-neutral-800/50
        hover:bg-neutral-800/40 group
        focus-within:bg-neutral-800/30
        ${rowBg}
      `}
    >
      {/* Checkbox */}
      <span className={COL_CHECKBOX}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          aria-label={`Select ${task.name}`}
          className="
            w-4 h-4 rounded border-neutral-600 bg-transparent
            checked:bg-brand-primary checked:border-brand-primary
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
            cursor-pointer
          "
        />
      </span>

      {/* WBS */}
      <span
        role="gridcell"
        className={`${COL_WBS} text-xs font-mono text-gantt-text-secondary text-right pr-2`}
      >
        {task.wbs}
      </span>

      {/* Name */}
      <span role="gridcell" className="flex-1 min-w-0 pr-2">
        {isRenaming ? (
          <input
            ref={inputRef}
            type="text"
            defaultValue={task.name}
            onBlur={(e) => onRename(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Rename task"
            className="
              w-full bg-transparent border-b border-brand-primary
              text-sm text-gantt-text-primary outline-none caret-white px-0
            "
          />
        ) : (
          <span
            className={`
              text-sm truncate block
              ${task.isSummary ? 'font-semibold text-gantt-text-primary' : 'text-gantt-text-primary'}
            `}
            title={task.isSummary ? undefined : 'Double-click to rename'}
          >
            {task.name}
          </span>
        )}
      </span>

      {/* Start */}
      <span
        role="gridcell"
        className={`${COL_START} text-xs text-gantt-text-secondary text-right pr-2`}
      >
        {task.start}
      </span>

      {/* Finish */}
      <span
        role="gridcell"
        className={`${COL_FINISH} text-xs text-gantt-text-secondary text-right pr-2`}
      >
        {task.finish}
      </span>

      {/* Duration */}
      <span
        role="gridcell"
        className={`${COL_DURATION} text-xs text-gantt-text-secondary text-right pr-2`}
      >
        {task.duration}d
      </span>

      {/* Progress */}
      <span role="gridcell" className={`${COL_PROGRESS} flex items-center gap-1.5 pr-2`}>
        <span className="flex-1 h-1.5 rounded-full bg-neutral-700" aria-hidden="true">
          <span
            className={`
              block h-full rounded-full
              ${task.isCritical ? 'bg-gantt-semantic-critical' : 'bg-brand-primary'}
            `}
            style={{ width: `${task.progress}%` }}
          />
        </span>
        <span className="text-xs text-gantt-text-secondary w-7 text-right">
          {task.progress}%
        </span>
      </span>

      {/* CP badge */}
      <span className={`${COL_CP} flex justify-center`}>
        {task.isCritical && (
          <span
            aria-label="Critical path"
            title="This task is on the critical path — a delay here delays the project end date"
            className="
              flex-shrink-0 text-xs font-bold
              text-gantt-semantic-critical border border-gantt-semantic-critical/50
              rounded px-1 leading-4
            "
          >
            CP
          </span>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TaskListView
// ---------------------------------------------------------------------------

export function TaskListView() {
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get('project');
  const { tasks, isLoading, error } = useGanttTasks();
  const { selectedIds, toggle, selectAll, clearSelection } = useTaskSelectionStore();
  const updateTask = useUpdateTask();
  const bulkDelete = useBulkDeleteTasks(projectId);

  const [sortCol, setSortCol] = useState<SortCol>('wbs');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [myTasksOnly, setMyTasksOnly] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  const handleHeaderClick = useCallback(
    (col: SortCol) => {
      if (sortCol === col) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortCol(col);
        setSortDir('asc');
      }
    },
    [sortCol],
  );

  const handleRename = useCallback((task: Task, newName: string) => {
    setRenamingId(null);
    if (newName.trim() === '' || newName === task.name) return;
    if (projectId) {
      updateTask.mutate({ id: task.id, projectId, name: newName.trim() });
    }
  }, [projectId, updateTask]);

  const handleBulkDelete = useCallback(() => {
    if (selectedIds.size === 0 || !projectId) return;
    bulkDelete.mutate([...selectedIds], { onSuccess: () => clearSelection() });
  }, [selectedIds, projectId, bulkDelete, clearSelection]);

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
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-11 rounded animate-pulse bg-neutral-800/60" />
        ))}
      </div>
    );
  }

  if (tasks.length === 0) return <TaskListEmptyState />;

  // Apply "my tasks" filter (stub — no auth yet, filter has no effect)
  const filtered = myTasksOnly ? tasks : tasks;
  const sorted = sortTasks(filtered, sortCol, sortDir);
  const allIds = sorted.map((t) => t.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));

  function SortIndicator({ col }: { col: SortCol }) {
    if (sortCol !== col) return null;
    return (
      <span aria-hidden="true" className="ml-0.5">
        {sortDir === 'asc' ? '↑' : '↓'}
      </span>
    );
  }

  function ColHeader({
    col,
    label,
    className,
  }: {
    col: SortCol;
    label: string;
    className: string;
  }) {
    return (
      <span
        role="columnheader"
        aria-sort={sortCol === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={className}
      >
        <button
          type="button"
          onClick={() => handleHeaderClick(col)}
          className="flex items-center gap-0.5 text-left w-full
            hover:text-gantt-text-primary transition-colors
            focus-visible:ring-1 focus-visible:ring-brand-primary focus-visible:outline-none"
        >
          {label}
          <SortIndicator col={col} />
        </button>
      </span>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gantt-surface overflow-hidden">
      {/* Sub-toolbar: select-all, my tasks, bulk delete */}
      <div className="flex items-center gap-3 px-3 h-9 border-b border-neutral-800 flex-shrink-0">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={() => (allSelected ? clearSelection() : selectAll(allIds))}
          aria-label={allSelected ? 'Deselect all tasks' : 'Select all tasks'}
          className="
            w-4 h-4 rounded border-neutral-600 bg-transparent
            checked:bg-brand-primary checked:border-brand-primary
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
            cursor-pointer
          "
        />
        {selectedIds.size > 0 && (
          <>
            <span className="text-xs text-gantt-text-secondary">
              {selectedIds.size} selected
            </span>
            <button
              type="button"
              onClick={handleBulkDelete}
              className="text-xs text-gantt-semantic-critical
                hover:underline
                focus-visible:ring-1 focus-visible:ring-brand-primary focus-visible:outline-none"
            >
              Delete
            </button>
          </>
        )}
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-xs text-gantt-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={myTasksOnly}
            onChange={(e) => setMyTasksOnly(e.target.checked)}
            className="
              w-4 h-4 rounded border-neutral-600 bg-transparent
              checked:bg-brand-primary checked:border-brand-primary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
            "
          />
          My tasks
        </label>
      </div>

      {/* Column headers */}
      <div
        role="row"
        className="flex items-center h-8 border-b border-neutral-800 px-2 flex-shrink-0
          text-xs font-semibold tracking-wide uppercase text-gantt-text-secondary"
        aria-hidden="true"
      >
        <span className={COL_CHECKBOX} />
        <ColHeader col="wbs" label="WBS" className={`${COL_WBS} text-right pr-2`} />
        <ColHeader col="name" label="Name" className="flex-1 min-w-0" />
        <ColHeader col="start" label="Start" className={`${COL_START} text-right pr-2`} />
        <ColHeader col="finish" label="Finish" className={`${COL_FINISH} text-right pr-2`} />
        <ColHeader
          col="duration"
          label="Dur"
          className={`${COL_DURATION} text-right pr-2`}
        />
        <ColHeader col="progress" label="Progress" className={`${COL_PROGRESS}`} />
        <span className={COL_CP} />
      </div>

      {/* Virtualized rows */}
      <div
        ref={scrollRef}
        role="grid"
        aria-label="Task list"
        aria-rowcount={sorted.length}
        className="flex-1 overflow-y-auto"
      >
        <VirtualRows
          tasks={sorted}
          selectedIds={selectedIds}
          renamingId={renamingId}
          scrollRef={scrollRef}
          onToggleSelect={(id) => toggle(id)}
          onStartRename={(id) => setRenamingId(id)}
          onRename={(task, name) => handleRename(task, name)}
          onCancelRename={() => setRenamingId(null)}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VirtualRows — separated so useVirtualizer has a stable scrollElement ref
// ---------------------------------------------------------------------------

interface VirtualRowsProps {
  tasks: Task[];
  selectedIds: Set<string>;
  renamingId: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  onToggleSelect: (id: string) => void;
  onStartRename: (id: string) => void;
  onRename: (task: Task, name: string) => void;
  onCancelRename: () => void;
}

function VirtualRows({
  tasks,
  selectedIds,
  renamingId,
  scrollRef,
  onToggleSelect,
  onStartRename,
  onRename,
  onCancelRename,
}: VirtualRowsProps) {
  const rowVirtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 5,
  });

  return (
    <div
      style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}
      aria-rowcount={tasks.length}
    >
      {rowVirtualizer.getVirtualItems().map((vRow) => {
        const task = tasks[vRow.index];
        if (!task) return null;
        return (
          <div
            key={task.id}
            aria-rowindex={vRow.index + 1}
            style={{
              position: 'absolute',
              top: vRow.start,
              left: 0,
              right: 0,
              height: vRow.size,
            }}
          >
            <TaskRow
              task={task}
              isSelected={selectedIds.has(task.id)}
              isRenaming={renamingId === task.id}
              onToggleSelect={() => onToggleSelect(task.id)}
              onStartRename={() => onStartRename(task.id)}
              onRename={(name) => onRename(task, name)}
              onCancelRename={onCancelRename}
            />
          </div>
        );
      })}
    </div>
  );
}
