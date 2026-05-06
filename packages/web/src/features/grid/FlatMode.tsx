import { useMemo, useCallback, useState, type KeyboardEvent } from 'react';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { useTaskSelectionStore } from '@/stores/taskSelectionStore';
import { useProjectId } from '@/hooks/useProjectId';
import type { Task } from '@/types';
import { sortTasks, type SortCol, type SortDir } from './sortHelpers';
import { getPhase } from './getPhase';
import { GridFilteredEmptyState } from './GridEmptyState';
import { VirtualRows, type ListItem } from './VirtualRows';
import type { GridFilterState } from './filters';
import { matchesFilters } from './filters';

interface FlatModeProps {
  filters: GridFilterState;
  onClearFilters: () => void;
}

/**
 * Flat mode adapter — renders the task list as a sortable virtualised table
 * with no hierarchy. Reads filter/search state from the GridView shell.
 *
 * Mirrors the legacy `TaskListView` body without the toolbar (the shell owns
 * search, filter chips, and bulk-action chrome).
 */
export function FlatMode({ filters, onClearFilters }: FlatModeProps) {
  const projectId = useProjectId() ?? null;
  const { tasks } = useScheduleTasks();
  const { selectedIds, toggle } = useTaskSelectionStore();
  const updateTask = useUpdateTask();

  const [sortCol, setSortCol] = useState<SortCol>('wbs');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const handleHeaderClick = useCallback((col: SortCol) => {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(col); setSortDir('asc'); }
  }, [sortCol]);

  const handleRename = useCallback((task: Task, newName: string) => {
    setRenamingId(null);
    if (newName.trim() === '' || newName === task.name) return;
    if (projectId) updateTask.mutate({ id: task.id, projectId, name: newName.trim() });
  }, [projectId, updateTask]);

  const tasksById = useMemo(
    () => new Map((tasks ?? []).map((t) => [t.id, t])),
    [tasks],
  );

  const filtered = useMemo(() => {
    const base = tasks ?? [];
    return sortTasks(base.filter((t) => matchesFilters(t, filters)), sortCol, sortDir);
  }, [tasks, filters, sortCol, sortDir]);

  const listItems = useMemo<ListItem[]>(
    () => filtered.map((task, rowIndex) => ({
      kind: 'task',
      task,
      phase: getPhase(task, tasksById),
      rowIndex,
    })),
    [filtered, tasksById],
  );

  if (filtered.length === 0) {
    return <GridFilteredEmptyState onClear={onClearFilters} />;
  }

  return (
    <>
      <ColumnHeaders sortCol={sortCol} sortDir={sortDir} onSort={handleHeaderClick} />
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
    </>
  );
}

interface ColumnHeadersProps {
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (col: SortCol) => void;
}

function SortIndicator({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return null;
  return <span aria-hidden="true" className="ml-0.5">{dir === 'asc' ? '↑' : '↓'}</span>;
}

function ColumnHeaders({ sortCol, sortDir, onSort }: ColumnHeadersProps) {
  const colHeader = (col: SortCol, label: string, className: string) => (
    <span
      role="columnheader"
      aria-sort={sortCol === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={className}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(col); } }}
        className="flex items-center gap-0.5 text-left w-full
          hover:text-neutral-text-primary transition-colors
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1"
      >
        {label}
        <SortIndicator active={sortCol === col} dir={sortDir} />
      </button>
    </span>
  );

  return (
    <div
      role="row"
      className="flex items-center h-9 border-b border-neutral-border px-3 flex-shrink-0
        bg-neutral-surface-sunken tppm-mono text-xs font-semibold tracking-widest uppercase
        text-neutral-text-secondary"
    >
      <span className="w-4 flex-shrink-0" />
      {colHeader('wbs', 'WBS', 'w-14 flex-shrink-0 text-right pr-2')}
      {colHeader('name', 'Name', 'flex-1 min-w-0')}
      <span role="columnheader" className="w-10 flex-shrink-0 text-center">Owner</span>
      {colHeader('start', 'Start', 'w-20 flex-shrink-0 text-right pr-2')}
      {colHeader('finish', 'Finish', 'w-20 flex-shrink-0 text-right pr-2')}
      {colHeader('duration', 'Dur', 'w-12 flex-shrink-0 text-right pr-2')}
      {colHeader('progress', 'Progress', 'w-28 flex-shrink-0')}
      <span role="columnheader" className="w-28 flex-shrink-0">Status</span>
    </div>
  );
}
