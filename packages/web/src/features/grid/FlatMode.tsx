import { useMemo, type ReactNode } from 'react';
import type { Task } from '@/types';
import { getPhase } from './getPhase';
import { GridFilteredEmptyState } from './GridEmptyState';
import { GridSurface } from './GridSurface';
import { type ListItem } from './VirtualRows';
import type { GridFilterState } from './filters';
import { useGridTaskRows, useUrlSyncedGridSort } from './useGridTaskRows';

interface FlatModeProps {
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
 * Flat mode adapter — renders the task list as a sortable virtualised table
 * with no hierarchy. Reads filter/search state from the GridView shell.
 *
 * Mirrors the legacy `TaskListView` body without the toolbar (the shell owns
 * search, filter chips, and bulk-action chrome).
 */
export function FlatMode({
  filters,
  onClearFilters,
  onOpenDetail,
  canEdit = true,
  filteredEmptyState,
}: FlatModeProps) {
  const sort = useUrlSyncedGridSort();
  const {
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

  const listItems = useMemo<ListItem[]>(
    () =>
      filtered.map((task, rowIndex) => ({
        kind: 'task',
        task,
        phase: getPhase(task, tasksById),
        rowIndex,
      })),
    [filtered, tasksById],
  );

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
