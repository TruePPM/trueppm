import {
  useRef, useState, useCallback, useEffect, useMemo,
  type KeyboardEvent, type FocusEvent,
} from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask, useBulkDeleteTasks } from '@/hooks/useTaskMutations';
import { useTaskSelectionStore } from '@/stores/taskSelectionStore';
import { exportTasksToCsv } from '@/utils/exportCsv';
import type { Task, TaskStatus } from '@/types';

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG:      'Backlog',
  NOT_STARTED:  'Not started',
  IN_PROGRESS:  'In progress',
  REVIEW:       'Review',
  ON_HOLD:      'On hold',
  COMPLETE:     'Done',
};

const STATUS_CLS: Record<TaskStatus, string> = {
  BACKLOG:      'border-neutral-border text-neutral-text-secondary',
  NOT_STARTED:  'border-neutral-border text-neutral-text-secondary',
  IN_PROGRESS:  'border-brand-primary/50 text-brand-primary',
  REVIEW:       'border-brand-accent/50 text-brand-accent-dark',
  ON_HOLD:      'border-semantic-at-risk/50 text-semantic-at-risk',
  COMPLETE:     'border-semantic-on-track/50 text-semantic-on-track',
};

function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span
      className={`inline-flex items-center h-5 px-1.5 border rounded text-xs font-medium
        ${STATUS_CLS[status] ?? STATUS_CLS.NOT_STARTED}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Owner avatar
// ---------------------------------------------------------------------------

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return (parts[0]?.[0] ?? '').toUpperCase();
  return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
}

function OwnerAvatar({ name }: { name: string }) {
  return (
    <span
      aria-label={name}
      title={name}
      className="w-6 h-6 rounded-full bg-brand-primary/20 text-brand-primary
        flex items-center justify-center text-xs font-semibold"
    >
      {initials(name)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
// Sort helpers
// ---------------------------------------------------------------------------

type SortCol = 'wbs' | 'name' | 'start' | 'finish' | 'duration' | 'progress';
type SortDir = 'asc' | 'desc';
type GroupBy = 'phase' | 'owner' | 'status' | 'none';

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

/**
 * Derive the "phase" for a task — the name of its closest summary-task ancestor.
 * Falls back to the task name if it is itself a summary, or "—" if no parent.
 */
function getPhase(task: Task, tasksById: Map<string, Task>): string {
  let current = task;
  while (current.parentId) {
    const parent = tasksById.get(current.parentId);
    if (!parent) break;
    if (parent.isSummary) return parent.name;
    current = parent;
  }
  if (task.isSummary) return task.name;
  return '—';
}

// ---------------------------------------------------------------------------
// Filter rail
// ---------------------------------------------------------------------------

interface ActiveFilter {
  key: 'owner' | 'status' | 'search';
  label: string;
  value: string;
}

interface FilterRailProps {
  search: string;
  ownerFilter: string;
  statusFilter: TaskStatus | '';
  onSearchChange: (v: string) => void;
  onRemove: (key: ActiveFilter['key']) => void;
}

function FilterRail({ search, ownerFilter, statusFilter, onSearchChange, onRemove }: FilterRailProps) {
  const [draft, setDraft] = useState(search);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = (v: string) => {
    setDraft(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSearchChange(v), 250);
  };

  const chips: ActiveFilter[] = [
    ...(ownerFilter ? [{ key: 'owner' as const, label: `Owner: ${ownerFilter}`, value: ownerFilter }] : []),
    ...(statusFilter ? [{ key: 'status' as const, label: `Status: ${STATUS_LABEL[statusFilter] ?? statusFilter}`, value: statusFilter }] : []),
  ];

  return (
    <div
      className="flex items-center gap-2 px-4 py-2 border-b border-neutral-border
        bg-neutral-surface-raised flex-shrink-0 flex-wrap"
    >
      {/* Search */}
      <div className="relative flex items-center">
        <svg
          aria-hidden="true"
          className="absolute left-2 w-3 h-3 text-neutral-text-secondary"
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
        </svg>
        <input
          type="search"
          value={draft}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Search tasks…"
          aria-label="Search tasks"
          className="
            pl-7 pr-2 h-7 w-52 text-xs rounded border border-neutral-border
            bg-neutral-surface text-neutral-text-primary placeholder:text-neutral-text-secondary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          "
        />
      </div>

      {/* Active filter chips */}
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1 h-6 px-2 rounded-full border
            border-brand-primary/40 bg-brand-primary/10 text-xs text-brand-primary"
        >
          {chip.label}
          <button
            type="button"
            onClick={() => onRemove(chip.key)}
            aria-label={`Remove ${chip.label} filter`}
            className="ml-0.5 hover:text-brand-primary-dark
              focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-primary rounded-full"
          >
            ✕
          </button>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

function TaskListEmptyState() {
  return (
    <div role="status" className="flex h-full flex-col items-center justify-center gap-3 bg-neutral-surface">
      <p className="text-sm text-neutral-text-primary font-medium">No tasks yet</p>
      <p className="text-xs text-neutral-text-secondary">Add tasks in the Schedule view to get started.</p>
    </div>
  );
}

function FilterEmptyState({ onClear }: { onClear: () => void }) {
  return (
    <div role="status" className="flex h-full flex-col items-center justify-center gap-3 bg-neutral-surface">
      <p className="text-sm text-neutral-text-primary font-medium">No tasks match these filters</p>
      <button
        type="button"
        onClick={onClear}
        className="text-xs text-brand-primary underline
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      >
        Clear filters
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfirmDeleteStrip
// ---------------------------------------------------------------------------

interface ConfirmDeleteStripProps {
  count: number;
  isDeleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDeleteStrip({ count, isDeleting, onConfirm, onCancel }: ConfirmDeleteStripProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { confirmRef.current?.focus(); }, []);

  useEffect(() => {
    if (isDeleting) return;
    const timer = setTimeout(onCancel, 5000);
    return () => clearTimeout(timer);
  }, [isDeleting, onCancel]);

  const noun = `task${count !== 1 ? 's' : ''}`;

  return (
    <div role="alertdialog" aria-label={`Confirm deletion of ${count} ${noun}`} className="flex items-center gap-3 w-full">
      <span className="flex-1 min-w-0">
        <span className="text-xs text-neutral-text-primary">Delete {count} {noun}?</span>
        {!isDeleting && (
          <span aria-hidden="true" className="block h-0.5 mt-0.5 rounded-full bg-neutral-surface-sunken overflow-hidden">
            <span className="block h-full rounded-full bg-semantic-critical/60" style={{ animation: 'shrink-bar 5s linear forwards' }} />
          </span>
        )}
      </span>
      <button
        ref={confirmRef}
        type="button"
        onClick={onConfirm}
        disabled={isDeleting}
        className="flex-shrink-0 h-7 px-3 rounded text-xs font-medium
          bg-semantic-critical/20 border border-semantic-critical/50 text-semantic-critical
          disabled:opacity-50
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1"
      >
        {isDeleting ? 'Deleting…' : 'Confirm delete'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={isDeleting}
        className="flex-shrink-0 h-7 px-3 rounded text-xs font-medium
          border border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary
          disabled:opacity-50
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1"
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
  phase: string;
  rowIndex: number;
  isSelected: boolean;
  isRenaming: boolean;
  onToggleSelect: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}

function TaskRow({
  task, phase, rowIndex, isSelected, isRenaming,
  onToggleSelect, onStartRename, onRename, onCancelRename,
}: TaskRowProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [isRenaming]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onRename(e.currentTarget.value);
    else if (e.key === 'Escape') onCancelRename();
  };

  const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
    const related = e.relatedTarget as Element | null;
    if (related && e.currentTarget.closest('[role="row"]')?.contains(related)) return;
    onRename(e.target.value);
  };

  const handleRowKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'F2') { e.preventDefault(); onStartRename(); }
  };

  // Alternating row background: even rows get surface-raised
  const altBg = rowIndex % 2 === 0 ? '' : 'bg-neutral-surface-raised';

  const rowBg = task.isCritical
    ? 'bg-semantic-critical/5 border-l-2 border-semantic-critical'
    : isSelected
    ? 'bg-brand-primary/10 border-l-2 border-brand-primary'
    : `border-l-2 border-transparent ${altBg}`;

  const firstAssignee = task.assignees[0];

  return (
    <div
      role="row"
      aria-selected={isSelected}
      tabIndex={0}
      onKeyDown={handleRowKeyDown}
      onDoubleClick={task.isSummary ? undefined : onStartRename}
      className={`
        flex items-center h-11 px-3 gap-2
        border-b border-neutral-border
        hover:bg-neutral-text-primary/5 group
        focus-within:bg-neutral-text-primary/5
        ${rowBg}
      `}
    >
      {/* Checkbox */}
      <input
        type="checkbox"
        checked={isSelected}
        onChange={onToggleSelect}
        aria-label={`Select ${task.name}`}
        className="
          w-4 h-4 rounded border-neutral-border bg-transparent flex-shrink-0
          checked:bg-brand-primary checked:border-brand-primary
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
          cursor-pointer
        "
      />

      {/* WBS */}
      <span role="gridcell" className="w-14 flex-shrink-0 tppm-mono text-xs text-neutral-text-secondary text-right pr-2">
        {task.wbs}
      </span>

      {/* Name + phase subtitle */}
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
            "
          />
        ) : (
          <span className="flex items-baseline gap-1.5 min-w-0">
            {task.isCritical && (
              <span
                aria-label="Critical path"
                title="This task is on the critical path — a delay here delays the project end date"
                className="flex-shrink-0 tppm-mono text-[11px] font-bold
                  text-semantic-critical border border-semantic-critical/50 rounded px-0.5 leading-4"
              >
                CP
              </span>
            )}
            <span
              className={`text-sm truncate ${task.isSummary ? 'font-semibold' : ''} text-neutral-text-primary`}
              aria-label={`${task.name}${phase !== '—' ? `, ${phase}` : ''}`}
            >
              {task.name}
            </span>
            {phase !== '—' && (
              <span className="text-xs text-neutral-text-disabled flex-shrink-0" aria-hidden="true">
                · {phase}
              </span>
            )}
          </span>
        )}
      </span>

      {/* Owner */}
      <span role="gridcell" className="w-10 flex-shrink-0 flex items-center justify-center">
        {firstAssignee ? <OwnerAvatar name={firstAssignee.name} /> : null}
      </span>

      {/* Start */}
      <span role="gridcell" className="w-20 flex-shrink-0 tppm-mono text-xs text-neutral-text-secondary text-right pr-2">
        {fmtDate(task.start)}
      </span>

      {/* Finish */}
      <span role="gridcell" className="w-20 flex-shrink-0 tppm-mono text-xs text-neutral-text-secondary text-right pr-2">
        {fmtDate(task.finish)}
      </span>

      {/* Duration */}
      <span role="gridcell" className="w-12 flex-shrink-0 tppm-mono text-xs text-neutral-text-secondary text-right pr-2">
        {task.duration}d
      </span>

      {/* Progress */}
      <span role="gridcell" className="w-28 flex-shrink-0 flex items-center gap-1.5">
        <span className="flex-1 h-1.5 rounded-full bg-neutral-border" aria-hidden="true">
          <span
            className={`block h-full rounded-full ${task.isCritical ? 'bg-semantic-critical' : task.isComplete ? 'bg-semantic-on-track' : 'bg-brand-primary'}`}
            style={{ width: `${task.progress}%` }}
          />
        </span>
        <span className="tppm-mono text-xs text-neutral-text-secondary w-7 text-right">{task.progress}%</span>
      </span>

      {/* Status pill */}
      <span role="gridcell" className="w-28 flex-shrink-0 flex items-center">
        <StatusPill status={task.status} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group header row
// ---------------------------------------------------------------------------

function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div
      role="row"
      className="flex items-center h-8 px-3 border-b border-neutral-border
        bg-neutral-surface-sunken text-xs font-semibold text-neutral-text-secondary sticky top-0 z-10"
    >
      <span>{label}</span>
      <span className="ml-2 text-neutral-text-disabled">({count})</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TaskListView
// ---------------------------------------------------------------------------

type DeletePhase = 'idle' | 'confirming' | 'deleting';

/** Flat list item — either a group header or a task row. */
type ListItem =
  | { kind: 'header'; label: string; count: number; id: string }
  | { kind: 'task'; task: Task; phase: string; rowIndex: number };

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
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [search, setSearch] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<TaskStatus | ''>('');

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleHeaderClick = useCallback((col: SortCol) => {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(col); setSortDir('asc'); }
  }, [sortCol]);

  const handleRename = useCallback((task: Task, newName: string) => {
    setRenamingId(null);
    if (newName.trim() === '' || newName === task.name) return;
    if (projectId) updateTask.mutate({ id: task.id, projectId, name: newName.trim() });
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

  const tasksById = useMemo(
    () => new Map((tasks ?? []).map((t) => [t.id, t])),
    [tasks],
  );

  // Filter + sort
  const filtered = useMemo(() => {
    const base = tasks ?? [];
    const q = search.toLowerCase();
    return sortTasks(
      base.filter((t) => {
        if (q && !t.name.toLowerCase().includes(q)) return false;
        if (ownerFilter && !t.assignees.some((a) => a.name === ownerFilter)) return false;
        if (statusFilter && t.status !== statusFilter) return false;
        return true;
      }),
      sortCol,
      sortDir,
    );
  }, [tasks, search, ownerFilter, statusFilter, sortCol, sortDir]);

  // Build flat list with optional group headers
  const listItems = useMemo((): ListItem[] => {
    if (groupBy === 'none') {
      return filtered.map((task, rowIndex) => ({
        kind: 'task',
        task,
        phase: getPhase(task, tasksById),
        rowIndex,
      }));
    }

    const getGroupKey = (task: Task): string => {
      if (groupBy === 'phase') return getPhase(task, tasksById);
      if (groupBy === 'owner') return task.assignees[0]?.name ?? 'Unassigned';
      if (groupBy === 'status') return STATUS_LABEL[task.status] ?? task.status;
      return '—';
    };

    const groups = new Map<string, Task[]>();
    for (const task of filtered) {
      const key = getGroupKey(task);
      const list = groups.get(key) ?? [];
      list.push(task);
      groups.set(key, list);
    }

    const items: ListItem[] = [];
    let rowIndex = 0;
    for (const [label, group] of groups) {
      items.push({ kind: 'header', label, count: group.length, id: `grp-${label}` });
      for (const task of group) {
        items.push({ kind: 'task', task, phase: getPhase(task, tasksById), rowIndex });
        rowIndex++;
      }
    }
    return items;
  }, [filtered, groupBy, tasksById]);

  const allTaskIds = filtered.map((t) => t.id);
  const allSelected = allTaskIds.length > 0 && allTaskIds.every((id) => selectedIds.has(id));

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-surface">
        <p className="text-sm text-semantic-critical">
          Couldn&apos;t load tasks.{' '}
          <button type="button" className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary" onClick={() => window.location.reload()}>
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

  function SortIndicator({ col }: { col: SortCol }) {
    if (sortCol !== col) return null;
    return <span aria-hidden="true" className="ml-0.5">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  function ColHeader({ col, label, className }: { col: SortCol; label: string; className: string }) {
    return (
      <span role="columnheader" aria-sort={sortCol === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} className={className}>
        <button
          type="button"
          onClick={() => handleHeaderClick(col)}
          className="flex items-center gap-0.5 text-left w-full
            hover:text-neutral-text-primary transition-colors
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1"
        >
          {label}
          <SortIndicator col={col} />
        </button>
      </span>
    );
  }

  const GROUP_CYCLE: GroupBy[] = ['none', 'phase', 'owner', 'status'];
  const GROUP_LABEL: Record<GroupBy, string> = {
    none: 'Group: None',
    phase: 'Group: Phase',
    owner: 'Group: Owner',
    status: 'Group: Status',
  };
  const nextGroup = GROUP_CYCLE[(GROUP_CYCLE.indexOf(groupBy) + 1) % GROUP_CYCLE.length] ?? 'none';

  return (
    <div className="flex flex-col h-full bg-neutral-surface overflow-hidden relative">
      {/* Sub-toolbar */}
      <div className="flex items-center gap-3 px-3 h-9 border-b border-neutral-border flex-shrink-0">
        {deletePhase !== 'idle' ? (
          <ConfirmDeleteStrip
            count={selectedIds.size}
            isDeleting={deletePhase === 'deleting'}
            onConfirm={handleConfirmDelete}
            onCancel={() => setDeletePhase('idle')}
          />
        ) : (
          <>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => (allSelected ? clearSelection() : selectAll(allTaskIds))}
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
                <span className="text-xs text-neutral-text-secondary">{selectedIds.size} selected</span>
                <button
                  type="button"
                  onClick={handleDeleteClick}
                  className="text-xs text-semantic-critical hover:underline
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                    focus-visible:ring-offset-1"
                >
                  Delete
                </button>
              </>
            )}
            <span className="tppm-mono text-xs text-neutral-text-secondary">
              {filtered.length} / {tasks.length} shown
            </span>
            <div className="flex-1" />
            {/* Group-by cycle */}
            <button
              type="button"
              onClick={() => setGroupBy(nextGroup)}
              className="border border-neutral-border rounded h-7 px-3 text-xs font-medium
                text-neutral-text-secondary hover:text-neutral-text-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                focus-visible:ring-offset-1"
            >
              {GROUP_LABEL[groupBy]}
            </button>
            <button
              type="button"
              onClick={() => exportTasksToCsv(filtered, `tasks-${projectId ?? 'export'}.csv`)}
              disabled={filtered.length === 0}
              aria-label={`Export ${filtered.length} tasks as CSV`}
              className="
                text-xs text-neutral-text-secondary border border-neutral-border rounded
                h-6 px-2 hover:text-neutral-text-primary hover:border-neutral-text-secondary
                disabled:opacity-40 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                focus-visible:ring-offset-1 transition-colors
              "
            >
              Export CSV
            </button>
          </>
        )}
      </div>

      {/* Filter rail — always visible; active chips only show when filters are set */}
      <FilterRail
        search={search}
        ownerFilter={ownerFilter}
        statusFilter={statusFilter}
        onSearchChange={setSearch}
        onRemove={(key) => {
          if (key === 'search') setSearch('');
          if (key === 'owner') setOwnerFilter('');
          if (key === 'status') setStatusFilter('');
        }}
      />

      {/* Column headers */}
      <div
        role="row"
        className="flex items-center h-9 border-b border-neutral-border px-3 flex-shrink-0
          bg-neutral-surface-sunken tppm-mono text-xs font-semibold tracking-widest uppercase
          text-neutral-text-secondary"
      >
        <span className="w-4 flex-shrink-0" />
        <ColHeader col="wbs" label="WBS" className="w-14 flex-shrink-0 text-right pr-2" />
        <ColHeader col="name" label="Name" className="flex-1 min-w-0" />
        <span role="columnheader" className="w-10 flex-shrink-0 text-center">Owner</span>
        <ColHeader col="start" label="Start" className="w-20 flex-shrink-0 text-right pr-2" />
        <ColHeader col="finish" label="Finish" className="w-20 flex-shrink-0 text-right pr-2" />
        <ColHeader col="duration" label="Dur" className="w-12 flex-shrink-0 text-right pr-2" />
        <ColHeader col="progress" label="Progress" className="w-28 flex-shrink-0" />
        <span role="columnheader" className="w-28 flex-shrink-0">Status</span>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <FilterEmptyState onClear={() => { setSearch(''); setOwnerFilter(''); setStatusFilter(''); }} />
      ) : (
        <VirtualRows
          items={listItems}
          rowCount={filtered.length}
          selectedIds={selectedIds}
          renamingId={renamingId}
          onToggleSelect={(id) => toggle(id)}
          onStartRename={(id) => setRenamingId(id)}
          onRename={(task, name) => handleRename(task, name)}
          onCancelRename={() => setRenamingId(null)}
        />
      )}

      {/* Delete result toast */}
      {toast && (
        <div
          role={toast.isError ? 'alert' : 'status'}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-50
            flex items-center gap-2 px-4 py-2 rounded
            bg-neutral-surface-raised border border-neutral-border
            text-xs text-neutral-text-primary whitespace-nowrap"
        >
          {!toast.isError && <span aria-hidden="true" className="text-semantic-on-track">✓</span>}
          {toast.text}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// VirtualRows
// ---------------------------------------------------------------------------

interface VirtualRowsProps {
  items: ListItem[];
  rowCount: number;
  selectedIds: Set<string>;
  renamingId: string | null;
  onToggleSelect: (id: string) => void;
  onStartRename: (id: string) => void;
  onRename: (task: Task, name: string) => void;
  onCancelRename: () => void;
}

/**
 * Owns the scroll container so the virtualizer and its scroll element are co-located.
 * Keeping them in the same component avoids ResizeObserver measuring height=0 when
 * the ref lives in a parent — the bug that caused blank rows (#247).
 */
function VirtualRows({
  items, rowCount, selectedIds, renamingId,
  onToggleSelect, onStartRename, onRename, onCancelRename,
}: VirtualRowsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const item = items[i];
      return item?.kind === 'header' ? 32 : 44;
    },
    overscan: 5,
  });

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label="Task list"
      aria-rowcount={rowCount}
      className="flex-1 overflow-y-auto"
      // CSS containment ensures ResizeObserver measures this element's height
      // correctly on first paint, same pattern as TaskListPanel in ScheduleView.
      style={{ contain: 'strict' }}
    >
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map((vRow) => {
          const item = items[vRow.index];
          if (!item) return null;
          return (
            <div
              key={item.kind === 'header' ? item.id : item.task.id}
              aria-rowindex={vRow.index + 1}
              style={{ position: 'absolute', top: vRow.start, left: 0, right: 0, height: vRow.size }}
            >
              {item.kind === 'header' ? (
                <GroupHeader label={item.label} count={item.count} />
              ) : (
                <TaskRow
                  task={item.task}
                  phase={item.phase}
                  rowIndex={item.rowIndex}
                  isSelected={selectedIds.has(item.task.id)}
                  isRenaming={renamingId === item.task.id}
                  onToggleSelect={() => onToggleSelect(item.task.id)}
                  onStartRename={() => onStartRename(item.task.id)}
                  onRename={(name) => onRename(item.task, name)}
                  onCancelRename={onCancelRename}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
