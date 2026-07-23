import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { canEditTask } from '@/lib/roles';
import { setSearchParam } from '@/hooks/useUrlSelectedId';
import { useTaskDrawerStore } from '@/stores/taskDrawerStore';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { QueryErrorState } from '@/components/QueryErrorState';
import { useProject } from '@/hooks/useProject';
import { useBulkDeleteTasks, useBulkRestoreTasks } from '@/hooks/useTaskMutations';
import { useTaskSelectionStore } from '@/stores/taskSelectionStore';
import { useWbsStore } from '@/stores/wbsStore';
import { exportTasksToCsv } from '@/utils/exportCsv';
import { TaskFormModal } from '@/features/board/TaskFormModal';
import type { Task, TaskStatus } from '@/types';
import { ModeToggle } from './ModeToggle';
import { GroupBySelector } from './GroupBySelector';
import { ChipStrip } from './ChipStrip';
import { ConfirmDeleteStrip } from './ConfirmDeleteStrip';
import { GridEmptyState } from './GridEmptyState';
import { FlatMode } from './FlatMode';
import { GroupedMode } from './GroupedMode';
import { OutlineMode } from './OutlineMode';
import {
  loadMode,
  saveMode,
  loadGroupBy,
  saveGroupBy,
  type GridMode,
  type GridGroupBy,
} from './persistence';
import { methodologyDefaultMode } from './methodologyDefaults';
import { matchesFilters, type GridFilterState } from './filters';

type DeletePhase = 'idle' | 'confirming' | 'deleting';

/**
 * Unified Grid view (issue #334, ADR-0053). Replaces the legacy `TaskListView`
 * (`/projects/:id/list`) and `WbsView` (`/projects/:id/wbs`) with a single
 * surface that switches between Flat / Outline / Grouped display modes via a
 * shell-level segmented control.
 *
 * Mode + group-by selection persist to localStorage per project. The default
 * mode falls back to a methodology-specific value when no persisted selection
 * exists (WATERFALL/HYBRID → outline, AGILE → flat).
 */
export function GridView() {
  const projectId = useProjectId() ?? null;
  const project = useProject(projectId);
  // Write-control gate (#2145): the Grid renders the same tasks as the Schedule,
  // so it must apply the same VIEWER read-only rule. Member+ may author; Viewers
  // may not. Pessimistic while the role loads (canEditTask(null) === false) so
  // Delete / select-all / create never flash for a viewer who turns out to lack
  // the permission — a false affordance that 403s on submit is worse than a
  // brief absence. The server is authoritative; this is the UX gate.
  const { role: currentRole } = useCurrentUserRole(projectId ?? undefined);
  const canEdit = canEditTask(currentRole);
  const { tasks, isLoading, error } = useScheduleTasks();
  const { selectedIds, selectAll, clearSelection } = useTaskSelectionStore();
  const { setSelectedTaskId: setOutlineSelectedTaskId, selectedTaskId: outlineSelectedTaskId } =
    useWbsStore();
  const bulkDelete = useBulkDeleteTasks(projectId);
  const bulkRestore = useBulkRestoreTasks(projectId);

  const methodology = project.data?.methodology ?? 'HYBRID';
  const agileFeatures = project.data?.agile_features === true;

  // Mode + group-by are persisted per project. The first paint reads from
  // localStorage; subsequent project switches reload from that project's
  // stored value (or the methodology default).
  const [mode, setModeState] = useState<GridMode>(() => {
    if (!projectId) return methodologyDefaultMode(methodology);
    return loadMode(projectId) ?? methodologyDefaultMode(methodology);
  });
  const [groupBy, setGroupByState] = useState<GridGroupBy>(() => {
    if (!projectId) return 'phase';
    return loadGroupBy(projectId) ?? 'phase';
  });

  useEffect(() => {
    if (!projectId) return;
    const persisted = loadMode(projectId);
    setModeState(persisted ?? methodologyDefaultMode(methodology));
  }, [projectId, methodology]);

  useEffect(() => {
    if (!projectId) return;
    const persisted = loadGroupBy(projectId);
    setGroupByState(persisted ?? 'phase');
  }, [projectId]);

  const setMode = useCallback(
    (next: GridMode) => {
      setModeState(next);
      if (projectId) saveMode(projectId, next);
    },
    [projectId],
  );

  const setGroupBy = useCallback(
    (next: GridGroupBy) => {
      setGroupByState(next);
      if (projectId) saveGroupBy(projectId, next);
    },
    [projectId],
  );

  // URL is the source of truth for the working set (issue #2046): search, owner,
  // and status filters, the `?due=overdue` drill-down, and the flat-mode sort
  // (in FlatMode) all round-trip through the query string so a filtered/sorted
  // grid survives a reload and can be shared as a link — matching the Board's
  // URL-authoritative pattern. `?task=` (the open drawer, #2031) rides the same
  // params object.
  const [searchParams, setSearchParams] = useSearchParams();

  // Filter state — search, owner, status, due. Seeded from the URL; owner+status
  // also set programmatically; the chip strip exposes the active set with × to
  // clear individual filters.
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '');
  const [searchDraft, setSearchDraft] = useState(() => searchParams.get('q') ?? '');
  const [ownerFilter, setOwnerFilter] = useState(() => searchParams.get('owner') ?? '');
  const [statusFilter, setStatusFilter] = useState<TaskStatus | ''>(
    () => (searchParams.get('status') as TaskStatus | null) ?? '',
  );
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mirror the applied filters into the URL. Empty values drop their key so a
  // clean grid has a clean URL. `search` (not the debounced `searchDraft`) is the
  // authoritative value, so the link reflects what the grid is actually showing.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const setParam = (key: string, value: string) => {
          if (value) next.set(key, value);
          else next.delete(key);
        };
        setParam('q', search);
        setParam('owner', ownerFilter);
        setParam('status', statusFilter);
        return next;
      },
      { replace: true },
    );
  }, [search, ownerFilter, statusFilter, setSearchParams]);

  // `?due=overdue` deep-link — the Overview "Tasks late" card drills in here so
  // the count it shows and the rows the grid shows use the same late definition
  // (filters.ts `isTaskOverdue` mirrors the server's `tasks_late_count`). The URL
  // param is the source of truth so the filter is shareable and survives reload.
  const overdue = searchParams.get('due') === 'overdue';

  const setOverdue = useCallback(
    (next: boolean) => {
      setSearchParam(setSearchParams, 'due', next ? 'overdue' : null);
    },
    [setSearchParams],
  );

  // Arriving via the overdue drill-down shows the late tasks as a single clean,
  // clickable flat list rather than scattered through the outline/grouped
  // hierarchy. This is a DERIVED display override, not a persisted mode change:
  // it never touches localStorage (so it can't clobber the user's saved
  // preference — the #1691 regression note), reverts the instant the filter is
  // cleared, and yields to a deliberate in-session mode change via the toolbar.
  const [manualModeSinceDrill, setManualModeSinceDrill] = useState(false);
  useEffect(() => {
    // Reset the manual-override flag whenever the drill-down param toggles.
    setManualModeSinceDrill(false);
  }, [overdue]);
  const effectiveMode: GridMode = overdue && !manualModeSinceDrill ? 'flat' : mode;

  const filters: GridFilterState = useMemo(
    () => ({ search, ownerFilter, statusFilter, dueFilter: overdue ? 'overdue' : 'all' }),
    [search, ownerFilter, statusFilter, overdue],
  );

  // Open a task's detail in the app-wide drawer (mounted in AppShell) when a
  // grid row is clicked — the grid otherwise had no click-through to detail.
  const openTaskDrawer = useTaskDrawerStore((s) => s.openTask);
  const drawerTask = useTaskDrawerStore((s) => s.task);
  const handleOpenDetail = useCallback(
    (task: Task) => {
      if (projectId) openTaskDrawer(task, projectId);
    },
    [openTaskDrawer, projectId],
  );

  // `?task=<id>` deep-link ⇄ open-drawer round-trip (issue #2031). On mount we
  // open the grid's app-wide drawer on the linked task once the task list loads;
  // from then on the open task id is mirrored back into the URL so a refresh or
  // link-copy round-trips. Grid is the only drawer host on this route, so there
  // is no double-open with the Schedule/Board/Sprints drawers.
  const initialGridTaskRef = useRef(searchParams.get('task'));
  const gridTaskConsumedRef = useRef(false);
  useEffect(() => {
    if (gridTaskConsumedRef.current) return;
    const id = initialGridTaskRef.current;
    if (!id) {
      gridTaskConsumedRef.current = true;
      return;
    }
    if (!projectId || !tasks || tasks.length === 0) return; // task list not loaded yet
    const match = tasks.find((t) => t.id === id);
    gridTaskConsumedRef.current = true;
    if (match) openTaskDrawer(match, projectId);
  }, [tasks, projectId, openTaskDrawer]);
  useEffect(() => {
    if (!gridTaskConsumedRef.current) return;
    setSearchParam(setSearchParams, 'task', drawerTask?.id ?? null);
  }, [drawerTask, setSearchParams]);

  const handleSearchChange = (v: string) => {
    setSearchDraft(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(v), 250);
  };

  const handleClearFilters = () => {
    setSearch('');
    setSearchDraft('');
    setOwnerFilter('');
    setStatusFilter('');
    setOverdue(false);
  };

  // Imperative expand-all / collapse-all signal for OutlineMode.
  const [expandAllCounter, setExpandAllCounter] = useState(0);
  const [collapseAllCounter, setCollapseAllCounter] = useState(0);

  // Bulk delete — Flat / Grouped only (Outline keeps single-row select via wbsStore).
  const [deletePhase, setDeletePhase] = useState<DeletePhase>('idle');
  const [toast, setToast] = useState<{
    text: string;
    isError: boolean;
    onUndo?: () => void;
  } | null>(null);

  useEffect(() => {
    if (!toast) return;
    // Give the Undo affordance a longer dwell than a plain confirmation (#2078).
    const timer = setTimeout(() => setToast(null), toast.onUndo ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleDeleteClick = useCallback(() => {
    if (selectedIds.size === 0 || !projectId) return;
    setDeletePhase('confirming');
  }, [selectedIds, projectId]);

  // Faithful bulk restore (#2078): each task (and its subtree/deps/assignments)
  // comes back under its original id, so the delete is genuinely undoable. Hoisted
  // out of the delete toast's `onUndo` closure to keep that handler flat.
  const handleUndoBulkDelete = useCallback(
    (ids: string[], count: number) => {
      bulkRestore.mutate(ids, {
        onSuccess: () =>
          setToast({
            text: `${count} task${count !== 1 ? 's' : ''} restored.`,
            isError: false,
          }),
        onError: () =>
          setToast({ text: "Couldn't restore tasks — try again.", isError: true }),
      });
    },
    [bulkRestore],
  );

  const handleConfirmDelete = useCallback(() => {
    const ids = [...selectedIds];
    const count = ids.length;
    setDeletePhase('deleting');
    bulkDelete.mutate(ids, {
      onSuccess: () => {
        clearSelection();
        setDeletePhase('idle');
        setToast({
          text: `${count} task${count !== 1 ? 's' : ''} deleted.`,
          isError: false,
          onUndo: () => handleUndoBulkDelete(ids, count),
        });
      },
      onError: () => {
        setDeletePhase('idle');
        setToast({ text: "Couldn't delete tasks — try again.", isError: true });
      },
    });
  }, [selectedIds, bulkDelete, clearSelection, handleUndoBulkDelete]);

  // TaskFormModal state — opened from "+ Task" or "+ Child" toolbar buttons.
  const [showAddForm, setShowAddForm] = useState(false);
  const [addFormParentId, setAddFormParentId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Filtered task set for the toolbar's "N / M shown" counter and CSV export.
  const filteredCount = useMemo(() => {
    if (!tasks) return 0;
    return tasks.filter((t) => matchesFilters(t, filters)).length;
  }, [tasks, filters]);

  const exportFilteredTasks = useCallback(() => {
    if (!tasks) return;
    const filteredSorted = tasks.filter((t) => matchesFilters(t, filters));
    exportTasksToCsv(filteredSorted, `tasks-${projectId ?? 'export'}.csv`);
  }, [tasks, filters, projectId]);

  const allSelected = (tasks ?? []).length > 0 && (tasks ?? []).every((t) => selectedIds.has(t.id));

  // Single shell-level live region for mode-switch announcements.
  const [modeAnnouncement, setModeAnnouncement] = useState('');
  const handleModeChange = (next: GridMode) => {
    setMode(next);
    // A deliberate toolbar mode change wins over the overdue drill-down's
    // derived flat view (and persists, since the user chose it).
    setManualModeSinceDrill(true);
    setDeletePhase('idle');
    if (next !== 'outline') clearSelection();
    const taskCount = tasks?.length ?? 0;
    setModeAnnouncement(
      next === 'flat'
        ? `Switched to flat mode. ${taskCount} task${taskCount === 1 ? '' : 's'} shown.`
        : next === 'outline'
          ? `Switched to outline mode.`
          : `Switched to grouped mode. Grouped by ${groupBy}.`,
    );
  };

  const handleGroupByChange = (next: GridGroupBy) => {
    setGroupBy(next);
    setModeAnnouncement(
      next === 'resource'
        ? `Grouped by resource. Tasks with multiple assignees appear under each resource.`
        : `Grouped by ${next}.`,
    );
  };

  if (error) {
    return <QueryErrorState message="Couldn't load tasks." />;
  }

  if (isLoading || !tasks) {
    return (
      <div className="flex h-full flex-col bg-neutral-surface p-3 gap-1" aria-busy="true">
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className="h-11 rounded motion-safe:animate-pulse bg-neutral-surface-sunken"
            style={{ marginLeft: effectiveMode === 'outline' ? `${(i % 3) * 16}px` : 0 }}
          />
        ))}
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col h-full bg-neutral-surface overflow-hidden">
        <Toolbar
          mode={effectiveMode}
          onModeChange={handleModeChange}
          groupBy={groupBy}
          onGroupByChange={handleGroupByChange}
          agileFeatures={agileFeatures}
          searchDraft={searchDraft}
          onSearchChange={handleSearchChange}
          filteredCount={0}
          totalCount={0}
          deletePhase="idle"
          selectedSize={0}
          allSelected={false}
          onSelectAll={() => {}}
          onClearSelection={() => {}}
          onDeleteClick={() => {}}
          onConfirmDelete={() => {}}
          onCancelDelete={() => {}}
          isDeleting={false}
          onAddTask={() => {
            setAddFormParentId(null);
            setShowAddForm(true);
          }}
          onAddChild={() => {}}
          showAddChild={false}
          onExpandAll={() => {}}
          onCollapseAll={() => {}}
          onCsvExport={() => {}}
          canExport={false}
          canEdit={canEdit}
        />
        <GridEmptyState
          onAddTask={
            projectId && canEdit
              ? () => {
                  setAddFormParentId(null);
                  setShowAddForm(true);
                }
              : undefined
          }
        />
        {showAddForm && projectId && (
          <TaskFormModal
            projectId={projectId}
            task={null}
            parentId={addFormParentId ?? undefined}
            isMobile={isMobile}
            onClose={() => {
              setShowAddForm(false);
              setAddFormParentId(null);
            }}
          />
        )}
      </div>
    );
  }

  const allTaskIds = tasks.map((t) => t.id);
  const selectionAllSelected =
    allTaskIds.length > 0 && allTaskIds.every((id) => selectedIds.has(id));

  return (
    <div className="flex flex-col h-full bg-neutral-surface overflow-hidden relative">
      <Toolbar
        mode={mode}
        onModeChange={handleModeChange}
        groupBy={groupBy}
        onGroupByChange={handleGroupByChange}
        agileFeatures={agileFeatures}
        searchDraft={searchDraft}
        onSearchChange={handleSearchChange}
        filteredCount={filteredCount}
        totalCount={tasks.length}
        deletePhase={deletePhase}
        selectedSize={selectedIds.size}
        allSelected={selectionAllSelected || allSelected}
        onSelectAll={() => (selectionAllSelected ? clearSelection() : selectAll(allTaskIds))}
        onClearSelection={clearSelection}
        onDeleteClick={handleDeleteClick}
        onConfirmDelete={handleConfirmDelete}
        onCancelDelete={() => setDeletePhase('idle')}
        isDeleting={deletePhase === 'deleting'}
        onAddTask={() => {
          setAddFormParentId(null);
          setShowAddForm(true);
        }}
        onAddChild={() => {
          setAddFormParentId(outlineSelectedTaskId ?? null);
          setShowAddForm(true);
        }}
        showAddChild={effectiveMode === 'outline' && !!outlineSelectedTaskId}
        onExpandAll={() => setExpandAllCounter((c) => c + 1)}
        onCollapseAll={() => setCollapseAllCounter((c) => c + 1)}
        onCsvExport={exportFilteredTasks}
        canExport={filteredCount > 0}
        canEdit={canEdit}
      />

      <ChipStrip
        search={search}
        ownerFilter={ownerFilter}
        statusFilter={statusFilter}
        overdue={overdue}
        onRemove={(key) => {
          if (key === 'search') {
            setSearch('');
            setSearchDraft('');
          }
          if (key === 'owner') setOwnerFilter('');
          if (key === 'status') setStatusFilter('');
          if (key === 'overdue') setOverdue(false);
        }}
      />

      {effectiveMode === 'flat' && (
        <FlatMode
          filters={filters}
          onClearFilters={handleClearFilters}
          onOpenDetail={handleOpenDetail}
          canEdit={canEdit}
        />
      )}
      {effectiveMode === 'outline' && (
        <OutlineMode
          filters={filters}
          onClearFilters={handleClearFilters}
          expandAllCounter={expandAllCounter}
          collapseAllCounter={collapseAllCounter}
        />
      )}
      {effectiveMode === 'grouped' && (
        <GroupedMode
          groupBy={groupBy}
          filters={filters}
          onClearFilters={handleClearFilters}
          onOpenDetail={handleOpenDetail}
          canEdit={canEdit}
        />
      )}

      {showAddForm && projectId && (
        <TaskFormModal
          projectId={projectId}
          task={null}
          parentId={addFormParentId ?? undefined}
          isMobile={isMobile}
          onClose={() => {
            setShowAddForm(false);
            setAddFormParentId(null);
            // Outline-mode "+ Child" leaves selection in place; nothing else to reset.
            if (effectiveMode !== 'outline') setOutlineSelectedTaskId(null);
          }}
        />
      )}

      {/* Shell-level live region — mode + group-by announcements. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {modeAnnouncement}
      </div>

      {toast && (
        <div
          role={toast.isError ? 'alert' : 'status'}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-50
            flex items-center gap-2 px-4 py-2 rounded
            bg-neutral-surface-raised border border-neutral-border
            text-xs text-neutral-text-primary whitespace-nowrap"
        >
          {!toast.isError && (
            <span aria-hidden="true" className="text-semantic-on-track">
              ✓
            </span>
          )}
          {toast.text}
          {toast.onUndo && (
            <button
              type="button"
              onClick={toast.onUndo}
              className="ml-1 font-semibold text-brand-primary underline underline-offset-2 hover:no-underline focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded-control"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface ToolbarProps {
  mode: GridMode;
  onModeChange: (next: GridMode) => void;
  groupBy: GridGroupBy;
  onGroupByChange: (next: GridGroupBy) => void;
  agileFeatures: boolean;
  searchDraft: string;
  onSearchChange: (v: string) => void;
  filteredCount: number;
  totalCount: number;
  deletePhase: DeletePhase;
  selectedSize: number;
  allSelected: boolean;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDeleteClick: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  isDeleting: boolean;
  onAddTask: () => void;
  onAddChild: () => void;
  showAddChild: boolean;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onCsvExport: () => void;
  canExport: boolean;
  /** Member+ may author (#2145). Below it, the select-all box, bulk Delete, and
   *  the +Task / +Child create buttons are suppressed — a Viewer never sees a
   *  destructive bulk flow that 403s per task. */
  canEdit: boolean;
}

function Toolbar({
  mode,
  onModeChange,
  groupBy,
  onGroupByChange,
  agileFeatures,
  searchDraft,
  onSearchChange,
  filteredCount,
  totalCount,
  deletePhase,
  selectedSize,
  allSelected,
  onSelectAll,
  onDeleteClick,
  onConfirmDelete,
  onCancelDelete,
  isDeleting,
  onAddTask,
  onAddChild,
  showAddChild,
  onExpandAll,
  onCollapseAll,
  onCsvExport,
  canExport,
  canEdit,
}: ToolbarProps) {
  if (deletePhase !== 'idle') {
    return (
      <div className="flex items-center gap-3 px-3 h-9 border-b border-neutral-border flex-shrink-0">
        <ConfirmDeleteStrip
          count={selectedSize}
          isDeleting={isDeleting}
          onConfirm={onConfirmDelete}
          onCancel={onCancelDelete}
        />
      </div>
    );
  }

  // Selection exists only to feed bulk Delete, so it is gated with authoring
  // (#2145): a Viewer has nothing to do with a selection and must not reach the
  // Delete button it enables.
  const supportsBulkSelect = mode !== 'outline' && canEdit;

  return (
    // Mobile (< md): controls wrap to 2 lines, so the container must grow to
    // contain them (`min-h-9` + `py-1`) — a fixed `h-9` clamps the height while
    // the wrapped rows overflow visibly and land on top of the task list below
    // (the #1708 overlap). Desktop (md:+) keeps the single fixed-height nowrap row.
    <div className="flex items-center gap-2 px-3 py-1 md:py-0 min-h-9 md:h-9 border-b border-neutral-border flex-shrink-0 flex-wrap md:flex-nowrap">
      <ModeToggle mode={mode} onChange={onModeChange} />

      {mode === 'grouped' && (
        <>
          <GroupBySelector
            groupBy={groupBy}
            onChange={onGroupByChange}
            showSprint={agileFeatures}
          />
          {groupBy === 'resource' && (
            <span
              role="img"
              aria-label="Tasks with multiple assignees appear under each resource"
              title="Tasks with multiple assignees appear under each resource."
              className="text-neutral-text-disabled cursor-help select-none text-xs"
            >
              ⓘ
            </span>
          )}
        </>
      )}

      <span className="hidden md:block border-r border-neutral-border h-5 mx-1" aria-hidden="true" />

      {/* Search — takes its own full-width row on mobile (`w-full` forces a wrap
          break); a fixed `w-52` sharing the mode-toggle row squeezed it to an
          icon-only sliver on a phone. Reverts to the fixed inline width at md:+. */}
      <div className="relative flex items-center w-full md:w-auto md:flex-none">
        <svg
          aria-hidden="true"
          className="absolute left-2 w-3 h-3 text-neutral-text-secondary"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"
          />
        </svg>
        <input
          type="search"
          value={searchDraft}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search tasks…"
          aria-label="Search tasks"
          className="
            pl-7 pr-2 h-7 w-full md:w-52 text-xs rounded border border-neutral-border
            bg-neutral-surface text-neutral-text-primary placeholder:text-neutral-text-secondary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          "
        />
      </div>

      {supportsBulkSelect && (
        // Same WCAG 2.5.8 treatment as the per-row select box (TaskRow): a
        // transparent centered `before:` overlay enlarges the touch hit-area
        // without resizing the 16px visual box, gated to below `md`. Capped to
        // 36px (h-9) here — not 44px — because this toolbar row is `h-9` and
        // `flex-wrap` below `md`: a 44px overlay would bleed past the line and
        // steal taps from adjacent wrapped controls. 36px still clears the 24px
        // SC 2.5.8 floor while fitting exactly within the toolbar line.
        <label
          className="
            relative flex items-center justify-center flex-shrink-0 cursor-pointer
            before:absolute before:left-1/2 before:top-1/2
            before:-translate-x-1/2 before:-translate-y-1/2
            before:h-9 before:w-9 before:content-[''] md:before:hidden
          "
        >
          <input
            type="checkbox"
            checked={allSelected}
            onChange={onSelectAll}
            aria-label={allSelected ? 'Deselect all tasks' : 'Select all tasks'}
            className="
              w-4 h-4 rounded border-neutral-border bg-transparent flex-shrink-0
              checked:bg-brand-primary checked:border-brand-primary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
              cursor-pointer
            "
          />
        </label>
      )}

      {supportsBulkSelect && selectedSize > 0 && (
        <>
          <span className="text-xs text-neutral-text-secondary">{selectedSize} selected</span>
          <button
            type="button"
            onClick={onDeleteClick}
            className="text-xs text-semantic-critical hover:underline
              focus:outline-none focus:ring-2 focus:ring-brand-primary
              focus:ring-offset-1"
          >
            Delete
          </button>
        </>
      )}

      <span className="tppm-mono text-xs text-neutral-text-secondary">
        {filteredCount} / {totalCount} shown
      </span>

      {/* Right-align spacer is desktop-only; on mobile it would claim a wrapped
          line and force the actions onto a third row. */}
      <div className="hidden md:block flex-1" />

      {/* Standalone toolbar buttons use focus: (not focus-visible:) so the ring shows
          on pointer-initiated focus in Firefox/Safari (rule 214, WCAG 2.4.7). The
          search input and select-all checkbox keep focus-visible: as form fields. */}
      {canEdit && (
        <button
          type="button"
          onClick={onAddTask}
          className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
            border border-neutral-border rounded h-7 px-3
            focus:outline-none focus:ring-2 focus:ring-brand-primary
            focus:ring-offset-1"
        >
          + Task
        </button>
      )}

      {canEdit && showAddChild && (
        <button
          type="button"
          onClick={onAddChild}
          aria-label="Add child task under selected"
          className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
            border border-neutral-border rounded h-7 px-3
            focus:outline-none focus:ring-2 focus:ring-brand-primary
            focus:ring-offset-1"
        >
          + Child
        </button>
      )}

      {mode === 'outline' && (
        <>
          <button
            type="button"
            onClick={onExpandAll}
            aria-label="Expand all"
            className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
              border border-neutral-border rounded h-7 px-3
              focus:outline-none focus:ring-2 focus:ring-brand-primary
              focus:ring-offset-1"
          >
            ⤢
          </button>
          <button
            type="button"
            onClick={onCollapseAll}
            aria-label="Collapse all"
            className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
              border border-neutral-border rounded h-7 px-3
              focus:outline-none focus:ring-2 focus:ring-brand-primary
              focus:ring-offset-1"
          >
            ⤡
          </button>
        </>
      )}

      <button
        type="button"
        onClick={onCsvExport}
        disabled={!canExport}
        aria-label="Export tasks as CSV"
        className="
          text-xs text-neutral-text-secondary border border-neutral-border rounded
          h-7 px-3 hover:text-neutral-text-primary hover:border-neutral-text-secondary
          disabled:opacity-40 disabled:cursor-not-allowed
          focus:outline-none focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-1 transition-colors
        "
      >
        CSV
      </button>
    </div>
  );
}
