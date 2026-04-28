import { useRef, useState, useCallback, useEffect, type RefObject, type KeyboardEvent, type FocusEvent } from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask, useBulkDeleteTasks } from '@/hooks/useTaskMutations';
import { useTaskSelectionStore } from '@/stores/taskSelectionStore';
import { exportTasksToCsv } from '@/utils/exportCsv';
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
      className="flex h-full flex-col items-center justify-center gap-3 bg-neutral-surface"
    >
      <p className="text-sm text-neutral-text-primary font-medium">No tasks yet</p>
      <p className="text-xs text-neutral-text-secondary">
        Add tasks in the Gantt view to get started.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfirmDeleteStrip — in-place replacement for the sub-toolbar during confirm
// ---------------------------------------------------------------------------

interface ConfirmDeleteStripProps {
  count: number;
  isDeleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDeleteStrip({ count, isDeleting, onConfirm, onCancel }: ConfirmDeleteStripProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  // Auto-cancel after 5 seconds if user takes no action
  useEffect(() => {
    if (isDeleting) return;
    const timer = setTimeout(onCancel, 5000);
    return () => clearTimeout(timer);
  }, [isDeleting, onCancel]);

  const noun = `task${count !== 1 ? 's' : ''}`;

  return (
    <div
      role="alertdialog"
      aria-label={`Confirm deletion of ${count} ${noun}`}
      className="flex items-center gap-3 w-full"
    >
      <span className="flex-1 min-w-0">
        <span className="text-xs text-neutral-text-primary">
          Delete {count} {noun}?
        </span>
        {!isDeleting && (
          <span aria-hidden="true" className="block h-0.5 mt-0.5 rounded-full bg-neutral-surface-sunken overflow-hidden">
            <span
              className="block h-full rounded-full bg-semantic-critical/60"
              style={{ animation: 'shrink-bar 5s linear forwards' }}
            />
          </span>
        )}
      </span>
      <button
        ref={confirmRef}
        type="button"
        onClick={onConfirm}
        disabled={isDeleting}
        aria-keyshortcuts="Enter"
        className="flex-shrink-0 h-7 px-3 rounded text-xs font-medium
          bg-semantic-critical/20 border border-semantic-critical/50
          text-semantic-critical disabled:opacity-50
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface"
      >
        {isDeleting ? 'Deleting…' : 'Confirm delete'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={isDeleting}
        aria-keyshortcuts="Escape"
        className="flex-shrink-0 h-7 px-3 rounded text-xs font-medium
          border border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary
          disabled:opacity-50
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface"
      >
        Cancel
      </button>
      <style>{`@keyframes shrink-bar { from { width: 100% } to { width: 0% } }`}</style>
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

  // Only commit on blur if focus is leaving the row entirely (not moving within it)
  const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
    const related = e.relatedTarget as Element | null;
    if (related && e.currentTarget.closest('[role="row"]')?.contains(related)) return;
    onRename(e.target.value);
  };

  const handleRowKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'F2') {
      e.preventDefault();
      onStartRename();
    }
  };

  const rowBg = task.isCritical
    ? 'bg-semantic-critical/5 border-l-2 border-semantic-critical'
    : isSelected
    ? 'bg-brand-primary/10 border-l-2 border-brand-primary'
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
        border-b border-neutral-border
        hover:bg-neutral-text-primary/5 group
        focus-within:bg-neutral-text-primary/5
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
            w-4 h-4 rounded border-neutral-border bg-transparent
            checked:bg-brand-primary checked:border-brand-primary
            focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
            cursor-pointer
          "
        />
      </span>

      {/* WBS */}
      <span
        role="gridcell"
        className={`${COL_WBS} text-xs font-mono text-neutral-text-secondary text-right pr-2`}
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
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            aria-label="Rename task"
            className="
              w-full bg-transparent border-b border-brand-primary
              text-sm text-neutral-text-primary outline-none caret-neutral-text-primary px-0
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              focus-visible:ring-offset-neutral-surface
            "
          />
        ) : (
          <span
            className={`
              text-sm truncate block
              ${task.isSummary ? 'font-semibold text-neutral-text-primary' : 'text-neutral-text-primary'}
            `}
            aria-label={`${task.name}, press F2 or double-click to rename`}
          >
            {task.name}
          </span>
        )}
      </span>

      {/* Start */}
      <span
        role="gridcell"
        className={`${COL_START} text-xs text-neutral-text-secondary text-right pr-2`}
      >
        {task.start}
      </span>

      {/* Finish */}
      <span
        role="gridcell"
        className={`${COL_FINISH} text-xs text-neutral-text-secondary text-right pr-2`}
      >
        {task.finish}
      </span>

      {/* Duration */}
      <span
        role="gridcell"
        className={`${COL_DURATION} text-xs text-neutral-text-secondary text-right pr-2`}
      >
        {task.duration}d
      </span>

      {/* Progress */}
      <span role="gridcell" className={`${COL_PROGRESS} flex items-center gap-1.5 pr-2`}>
        <span className="flex-1 h-1.5 rounded-full bg-neutral-border" aria-hidden="true">
          <span
            className={`
              block h-full rounded-full
              ${task.isCritical ? 'bg-semantic-critical' : 'bg-brand-primary'}
            `}
            style={{ width: `${task.progress}%` }}
          />
        </span>
        <span className="text-xs text-neutral-text-secondary w-7 text-right">
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
              text-semantic-critical border border-semantic-critical/50
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

type DeletePhase = 'idle' | 'confirming' | 'deleting';

export function TaskListView() {
  const projectId = useProjectId() ?? null;
  const { tasks, isLoading, error } = useScheduleTasks();
  const { selectedIds, toggle, selectAll, clearSelection } = useTaskSelectionStore();
  const updateTask = useUpdateTask();
  const bulkDelete = useBulkDeleteTasks(projectId);

  const [sortCol, setSortCol] = useState<SortCol>('wbs');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletePhase, setDeletePhase] = useState<DeletePhase>('idle');
  const [toast, setToast] = useState<{ text: string; isError: boolean } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-dismiss toast after 4 seconds
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

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

  const handleDeleteClick = useCallback(() => {
    if (selectedIds.size === 0 || !projectId) return;
    setDeletePhase('confirming');
  }, [selectedIds, projectId]);

  const handleConfirmDelete = useCallback(() => {
    const count = selectedIds.size;
    setDeletePhase('deleting');
    bulkDelete.mutate([...selectedIds], {
      onSuccess: () => {
        clearSelection();
        setDeletePhase('idle');
        setToast({ text: `${count} task${count !== 1 ? 's' : ''} deleted.`, isError: false });
      },
      onError: () => {
        setDeletePhase('idle');
        setToast({ text: "Couldn't delete tasks — try again.", isError: true });
      },
    });
  }, [selectedIds, bulkDelete, clearSelection]);

  const handleCancelDelete = useCallback(() => setDeletePhase('idle'), []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-surface">
        <p className="text-sm text-semantic-critical">
          Couldn&apos;t load tasks.{' '}
          <button
            type="button"
            className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
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
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-11 rounded animate-pulse bg-neutral-surface-sunken" />
        ))}
      </div>
    );
  }

  if (tasks.length === 0) return <TaskListEmptyState />;

  const sorted = sortTasks(tasks, sortCol, sortDir);
  const allIds = sorted.map((t) => t.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));

  function SortIndicator({ col }: { col: SortCol }) {
    if (sortCol !== col) return null;
    return <span aria-hidden="true" className="ml-0.5">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  function ColHeader({ col, label, className }: { col: SortCol; label: string; className: string }) {
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
            hover:text-neutral-text-primary transition-colors
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface"
        >
          {label}
          <SortIndicator col={col} />
        </button>
      </span>
    );
  }

  return (
    <div className="flex flex-col h-full bg-neutral-surface overflow-hidden relative">
      {/* Sub-toolbar */}
      <div className="flex items-center gap-3 px-3 h-9 border-b border-neutral-border flex-shrink-0">
        {deletePhase !== 'idle' ? (
          <ConfirmDeleteStrip
            count={selectedIds.size}
            isDeleting={deletePhase === 'deleting'}
            onConfirm={handleConfirmDelete}
            onCancel={handleCancelDelete}
          />
        ) : (
          <>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => (allSelected ? clearSelection() : selectAll(allIds))}
              aria-label={allSelected ? 'Deselect all tasks' : 'Select all tasks'}
              className="
                w-4 h-4 rounded border-neutral-border bg-transparent
                checked:bg-brand-primary checked:border-brand-primary
                focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
                cursor-pointer
              "
            />
            {selectedIds.size > 0 && (
              <>
                <span className="text-xs text-neutral-text-secondary">
                  {selectedIds.size} selected
                </span>
                <button
                  type="button"
                  onClick={handleDeleteClick}
                  className="text-xs text-semantic-critical hover:underline
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                    focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface"
                >
                  Delete
                </button>
              </>
            )}
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => exportTasksToCsv(sorted, `tasks-${projectId ?? 'export'}.csv`)}
              disabled={sorted.length === 0}
              aria-label={`Export ${sorted.length} tasks as CSV`}
              className="
                text-xs text-neutral-text-secondary border border-neutral-border rounded
                h-6 px-2 hover:text-neutral-text-primary hover:border-neutral-text-secondary
                disabled:opacity-40 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface
                transition-colors
              "
            >
              Export CSV
            </button>
            {/* My tasks — disabled until auth is wired (#auth) */}
            <label
              className="flex items-center gap-1.5 text-xs text-neutral-text-disabled cursor-not-allowed"
              title="Requires sign-in — coming in a future update"
            >
              <input
                type="checkbox"
                disabled
                aria-disabled="true"
                readOnly
                checked={false}
                className="w-4 h-4 rounded border-neutral-border bg-transparent opacity-50 cursor-not-allowed
                  focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
              />
              My tasks
              <span aria-hidden="true" className="text-neutral-text-disabled">ⓘ</span>
            </label>
          </>
        )}
      </div>

      {/* Column headers */}
      <div
        role="row"
        className="flex items-center h-8 border-b border-neutral-border px-2 flex-shrink-0
          text-xs font-semibold tracking-wide uppercase text-neutral-text-secondary"
      >
        <span className={COL_CHECKBOX} />
        <ColHeader col="wbs" label="WBS" className={`${COL_WBS} text-right pr-2`} />
        <ColHeader col="name" label="Name" className="flex-1 min-w-0" />
        <ColHeader col="start" label="Start" className={`${COL_START} text-right pr-2`} />
        <ColHeader col="finish" label="Finish" className={`${COL_FINISH} text-right pr-2`} />
        <ColHeader col="duration" label="Dur" className={`${COL_DURATION} text-right pr-2`} />
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

      {/* Delete result toast */}
      {toast && (
        <div
          role={toast.isError ? 'alert' : 'status'}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-50
            flex items-center gap-2 px-4 py-2 rounded
            bg-neutral-surface-raised border border-neutral-border
            text-xs text-neutral-text-primary whitespace-nowrap"
        >
          {!toast.isError && (
            <span aria-hidden="true" className="text-semantic-on-track">✓</span>
          )}
          {toast.text}
        </div>
      )}
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
    <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
      {rowVirtualizer.getVirtualItems().map((vRow) => {
        const task = tasks[vRow.index];
        if (!task) return null;
        return (
          <div
            key={task.id}
            aria-rowindex={vRow.index + 1}
            style={{ position: 'absolute', top: vRow.start, left: 0, right: 0, height: vRow.size }}
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
