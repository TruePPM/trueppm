import { useMemo, type ReactNode } from 'react';
import { useSprints } from '@/hooks/useSprints';
import type { Task } from '@/types';
import { getPhase } from './getPhase';
import { STATUS_LABEL } from './ui';
import type { GridGroupBy } from './persistence';
import { GridFilteredEmptyState } from './GridEmptyState';
import { GridSurface } from './GridSurface';
import { type ListItem } from './VirtualRows';
import type { GridFilterState } from './filters';
import { useGridTaskRows, useLocalGridSort } from './useGridTaskRows';

interface GroupedModeProps {
  groupBy: GridGroupBy;
  filters: GridFilterState;
  onClearFilters: () => void;
  /** Overrides the default filtered-empty state — the Grid supplies one
   *  carrying the multi-facet diagnosis (#2387). */
  filteredEmptyState?: ReactNode;
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
  filteredEmptyState,
  onOpenDetail,
  canEdit = true,
}: GroupedModeProps) {
  const sort = useLocalGridSort();
  const {
    projectId,
    selectedIds,
    toggle,
    sortCol,
    sortDir,
    handleHeaderClick,
    renamingId,
    setRenamingId,
    handleRename,
    tasksById,
    filtered,
  } = useGridTaskRows({ filters, sort });

  const { sprints } = useSprints(projectId ?? undefined);

  const sprintNameById = useMemo(() => new Map(sprints.map((s) => [s.id, s.name])), [sprints]);

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
    return filteredEmptyState ?? <GridFilteredEmptyState onClear={onClearFilters} />;
  }

  return (
    <GridSurface
      items={listItems}
      sortCol={sortCol}
      sortDir={sortDir}
      onSort={handleHeaderClick}
      selectedIds={selectedIds}
      renamingId={renamingId}
      onToggleSelect={(id) => toggle(id)}
      onStartRename={(id) => setRenamingId(id)}
      onRename={(task, name) => handleRename(task, name)}
      onCancelRename={() => setRenamingId(null)}
      onOpenDetail={onOpenDetail}
      selectable={canEdit}
    />
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
