import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useSearchParams } from 'react-router';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { useTaskSelectionStore } from '@/stores/taskSelectionStore';
import { useProjectId } from '@/hooks/useProjectId';
import type { Task } from '@/types';
import { sortTasks, type SortCol, type SortDir } from './sortHelpers';
import type { GridFilterState } from './filters';
import { matchesFilters } from './filters';

/**
 * Sort state plus its setters. Split behind an interface so a mode can choose a
 * plain `useState` sort or a URL-synced one WITHOUT the router dependency
 * leaking into modes that do not want it — GroupedMode renders outside a Router
 * in its own tests, and calling `useSearchParams()` there throws.
 */
export interface GridSortState {
  sortCol: SortCol;
  sortDir: SortDir;
  setSortCol: Dispatch<SetStateAction<SortCol>>;
  setSortDir: Dispatch<SetStateAction<SortDir>>;
}

/** Component-local sort — no router involvement. */
export function useLocalGridSort(): GridSortState {
  const [sortCol, setSortCol] = useState<SortCol>('wbs');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  return { sortCol, sortDir, setSortCol, setSortDir };
}

/**
 * Sort mirrored into `?sort=`/`?dir=` so a sorted view survives a reload and is
 * shareable (#2046). Requires a Router. The `wbs`/`asc` default is kept out of
 * the URL to keep a clean grid's link clean; only a non-default sort writes the
 * params back. Initial state is read in the `useState` initializer so an
 * incoming `?sort=` is honored on the first render rather than after a flash.
 */
export function useUrlSyncedGridSort(): GridSortState {
  const [searchParams, setSearchParams] = useSearchParams();
  const [sortCol, setSortCol] = useState<SortCol>(
    () => (searchParams.get('sort') as SortCol | null) ?? 'wbs',
  );
  const [sortDir, setSortDir] = useState<SortDir>(() =>
    searchParams.get('dir') === 'desc' ? 'desc' : 'asc',
  );

  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (sortCol !== 'wbs') next.set('sort', sortCol);
        else next.delete('sort');
        if (sortDir !== 'asc') next.set('dir', sortDir);
        else next.delete('dir');
        return next;
      },
      { replace: true },
    );
  }, [sortCol, sortDir, setSearchParams]);

  return { sortCol, sortDir, setSortCol, setSortDir };
}

interface UseGridTaskRowsOptions {
  filters: GridFilterState;
  /** Sort state, from `useLocalGridSort()` or `useUrlSyncedGridSort()`. */
  sort: GridSortState;
}

/**
 * Shared row state for the Grid's task-list modes (FlatMode, GroupedMode).
 *
 * Owns the pieces both modes need identically — the sort header handler,
 * inline-rename state, the id→task index phase resolution needs, and the
 * filtered+sorted task list. Each mode keeps only what is genuinely its own:
 * FlatMode's 1:1 row mapping, GroupedMode's bucketing by dimension.
 */
export function useGridTaskRows({ filters, sort }: UseGridTaskRowsOptions) {
  const { sortCol, sortDir, setSortCol, setSortDir } = sort;
  const projectId = useProjectId() ?? null;
  const { tasks } = useScheduleTasks();
  const { selectedIds, toggle } = useTaskSelectionStore();
  const updateTask = useUpdateTask();

  const [renamingId, setRenamingId] = useState<string | null>(null);

  const handleHeaderClick = useCallback(
    (col: SortCol) => {
      if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      else {
        setSortCol(col);
        setSortDir('asc');
      }
    },
    [sortCol, setSortCol, setSortDir],
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

  const filtered = useMemo(() => {
    const base = tasks ?? [];
    return sortTasks(
      base.filter((t) => matchesFilters(t, filters)),
      sortCol,
      sortDir,
    );
  }, [tasks, filters, sortCol, sortDir]);

  return {
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
  };
}
