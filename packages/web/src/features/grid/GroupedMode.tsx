import { useMemo, useCallback, useState, type KeyboardEvent } from 'react';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { useTaskSelectionStore } from '@/stores/taskSelectionStore';
import { useProjectId } from '@/hooks/useProjectId';
import { useSprints } from '@/hooks/useSprints';
import type { Task } from '@/types';
import { sortTasks, type SortCol, type SortDir } from './sortHelpers';
import { getPhase } from './getPhase';
import { STATUS_LABEL } from './ui';
import type { GridGroupBy } from './persistence';
import { GridFilteredEmptyState } from './GridEmptyState';
import { VirtualRows, type ListItem } from './VirtualRows';
import type { GridFilterState } from './filters';
import { matchesFilters } from './filters';

interface GroupedModeProps {
  groupBy: GridGroupBy;
  filters: GridFilterState;
  onClearFilters: () => void;
  onOpenDetail?: (task: Task) => void;
  /** Member+ authoring (#2145) — gates the per-row select checkbox. */
  canEdit?: boolean;
}

/**
 * Grouped mode adapter — groups tasks by the selected dimension. Resource
 * grouping intentionally duplicates multi-assignee tasks under each resource
 * group (ADR-0053 § 7); the help-icon tooltip in the toolbar carries that copy.
 */
export function GroupedMode({
  groupBy,
  filters,
  onClearFilters,
  onOpenDetail,
  canEdit = true,
}: GroupedModeProps) {
  const projectId = useProjectId() ?? null;
  const { tasks } = useScheduleTasks();
  const { sprints } = useSprints(projectId ?? undefined);
  const { selectedIds, toggle } = useTaskSelectionStore();
  const updateTask = useUpdateTask();

  const [sortCol, setSortCol] = useState<SortCol>('wbs');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const handleHeaderClick = useCallback(
    (col: SortCol) => {
      if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      else {
        setSortCol(col);
        setSortDir('asc');
      }
    },
    [sortCol],
  );

  const handleRename = useCallback(
    (task: Task, newName: string) => {
      setRenamingId(null);
      if (newName.trim() === '' || newName === task.name) return;
      if (projectId) updateTask.mutate({ id: task.id, projectId, name: newName.trim() });
    },
    [projectId, updateTask],
  );

  const tasksById = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);

  const sprintNameById = useMemo(() => new Map(sprints.map((s) => [s.id, s.name])), [sprints]);

  const filtered = useMemo(() => {
    const base = tasks ?? [];
    return sortTasks(
      base.filter((t) => matchesFilters(t, filters)),
      sortCol,
      sortDir,
    );
  }, [tasks, filters, sortCol, sortDir]);

  const listItems = useMemo<ListItem[]>(() => {
    if (filtered.length === 0) return [];

    // Build group buckets. For groupBy === 'resource', a multi-assignee task
    // appears in every group its assignees belong to (intentional per ADR-0053).
    const groups = new Map<string, Task[]>();

    for (const task of filtered) {
      const keys = groupKeys(task, groupBy, tasksById, sprintNameById);
      for (const key of keys) {
        const list = groups.get(key) ?? [];
        list.push(task);
        groups.set(key, list);
      }
    }

    const sortedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    const items: ListItem[] = [];
    let rowIndex = 0;
    for (const key of sortedKeys) {
      const group = groups.get(key) ?? [];
      items.push({ kind: 'header', label: key, count: group.length, id: `grp-${key}` });
      for (const task of group) {
        items.push({ kind: 'task', task, phase: getPhase(task, tasksById), rowIndex });
        rowIndex++;
      }
    }
    return items;
  }, [filtered, groupBy, tasksById, sprintNameById]);

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
        onOpenDetail={onOpenDetail}
        selectable={canEdit}
      />
    </>
  );
}

/**
 * Resolve the group key(s) for a task. Most dimensions return one key; resource
 * returns one key per assignee (or "Unassigned" for unassigned tasks). The
 * Unassigned bucket also catches sprintless tasks when groupBy === 'sprint'.
 */
function groupKeys(
  task: Task,
  groupBy: GridGroupBy,
  tasksById: Map<string, Task>,
  sprintNameById: Map<string, string>,
): string[] {
  switch (groupBy) {
    case 'phase':
      return [getPhase(task, tasksById)];
    case 'owner':
      return [task.assignees[0]?.name ?? 'Unassigned'];
    case 'status':
      return [STATUS_LABEL[task.status] ?? task.status];
    case 'sprint':
      return [task.sprintId ? (sprintNameById.get(task.sprintId) ?? 'Unknown sprint') : 'Backlog'];
    case 'resource':
      if (task.assignees.length === 0) return ['Unassigned'];
      return task.assignees.map((a) => a.name);
    default:
      return ['—'];
  }
}

interface ColumnHeadersProps {
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (col: SortCol) => void;
}

function SortIndicator({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return null;
  return (
    <span aria-hidden="true" className="ml-0.5">
      {dir === 'asc' ? '↑' : '↓'}
    </span>
  );
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
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSort(col);
          }
        }}
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
      className="hidden md:flex items-center h-9 border-b border-neutral-border px-3 flex-shrink-0
        bg-neutral-surface-sunken tppm-mono text-xs font-semibold tracking-widest uppercase
        text-neutral-text-secondary"
    >
      <span className="w-4 flex-shrink-0" />
      {colHeader('wbs', 'WBS', 'w-14 flex-shrink-0 text-right pr-2')}
      {colHeader('name', 'Name', 'flex-1 min-w-0')}
      <span role="columnheader" className="w-10 flex-shrink-0 text-center">
        Owner
      </span>
      {colHeader('start', 'Start', 'w-20 flex-shrink-0 text-right pr-2')}
      {colHeader('finish', 'Finish', 'w-20 flex-shrink-0 text-right pr-2')}
      {colHeader('duration', 'Dur', 'w-12 flex-shrink-0 text-right pr-2')}
      {colHeader('progress', 'Progress', 'w-28 flex-shrink-0')}
      <span role="columnheader" className="w-28 flex-shrink-0">
        Status
      </span>
    </div>
  );
}
