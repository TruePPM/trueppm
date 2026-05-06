import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useProject } from '@/hooks/useProject';
import { useBulkDeleteTasks } from '@/hooks/useTaskMutations';
import { useTaskSelectionStore } from '@/stores/taskSelectionStore';
import { useWbsStore } from '@/stores/wbsStore';
import { exportTasksToCsv } from '@/utils/exportCsv';
import { TaskFormModal } from '@/features/board/TaskFormModal';
import type { TaskStatus } from '@/types';
import { ModeToggle } from './ModeToggle';
import { GroupBySelector } from './GroupBySelector';
import { ChipStrip } from './ChipStrip';
import { ConfirmDeleteStrip } from './ConfirmDeleteStrip';
import { GridEmptyState } from './GridEmptyState';
import { FlatMode } from './FlatMode';
import { GroupedMode } from './GroupedMode';
import { OutlineMode } from './OutlineMode';
import {
  loadMode, saveMode, loadGroupBy, saveGroupBy,
  type GridMode, type GridGroupBy,
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
  const { tasks, isLoading, error } = useScheduleTasks();
  const { selectedIds, selectAll, clearSelection } = useTaskSelectionStore();
  const { setSelectedTaskId: setOutlineSelectedTaskId, selectedTaskId: outlineSelectedTaskId } = useWbsStore();
  const bulkDelete = useBulkDeleteTasks(projectId);

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

  const setMode = useCallback((next: GridMode) => {
    setModeState(next);
    if (projectId) saveMode(projectId, next);
  }, [projectId]);

  const setGroupBy = useCallback((next: GridGroupBy) => {
    setGroupByState(next);
    if (projectId) saveGroupBy(projectId, next);
  }, [projectId]);

  // Filter state — search, owner, status. Owner+status set programmatically;
  // chip strip exposes the active set with × to clear individual filters.
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<TaskStatus | ''>('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filters: GridFilterState = useMemo(
    () => ({ search, ownerFilter, statusFilter }),
    [search, ownerFilter, statusFilter],
  );

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
  };

  // Imperative expand-all / collapse-all signal for OutlineMode.
  const [expandAllCounter, setExpandAllCounter] = useState(0);
  const [collapseAllCounter, setCollapseAllCounter] = useState(0);

  // Bulk delete — Flat / Grouped only (Outline keeps single-row select via wbsStore).
  const [deletePhase, setDeletePhase] = useState<DeletePhase>('idle');
  const [toast, setToast] = useState<{ text: string; isError: boolean } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

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

  // TaskFormModal state — opened from "+ Task" or "+ Child" toolbar buttons.
  const [showAddForm, setShowAddForm] = useState(false);
  const [addFormParentId, setAddFormParentId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
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

  const allSelected = (tasks ?? []).length > 0
    && (tasks ?? []).every((t) => selectedIds.has(t.id));

  // Single shell-level live region for mode-switch announcements.
  const [modeAnnouncement, setModeAnnouncement] = useState('');
  const handleModeChange = (next: GridMode) => {
    setMode(next);
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
          <div
            key={i}
            className="h-11 rounded animate-pulse bg-neutral-surface-sunken"
            style={{ marginLeft: mode === 'outline' ? `${(i % 3) * 16}px` : 0 }}
          />
        ))}
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col h-full bg-neutral-surface overflow-hidden">
        <Toolbar
          mode={mode} onModeChange={handleModeChange}
          groupBy={groupBy} onGroupByChange={handleGroupByChange}
          agileFeatures={agileFeatures}
          searchDraft={searchDraft} onSearchChange={handleSearchChange}
          filteredCount={0} totalCount={0}
          deletePhase="idle"
          selectedSize={0}
          allSelected={false}
          onSelectAll={() => {}}
          onClearSelection={() => {}}
          onDeleteClick={() => {}}
          onConfirmDelete={() => {}}
          onCancelDelete={() => {}}
          isDeleting={false}
          onAddTask={() => { setAddFormParentId(null); setShowAddForm(true); }}
          onAddChild={() => {}}
          showAddChild={false}
          onExpandAll={() => {}}
          onCollapseAll={() => {}}
          onCsvExport={() => {}}
          canExport={false}
        />
        <GridEmptyState
          onAddTask={projectId ? () => { setAddFormParentId(null); setShowAddForm(true); } : undefined}
        />
        {showAddForm && projectId && (
          <TaskFormModal
            projectId={projectId}
            task={null}
            parentId={addFormParentId ?? undefined}
            isMobile={isMobile}
            onClose={() => { setShowAddForm(false); setAddFormParentId(null); }}
          />
        )}
      </div>
    );
  }

  const allTaskIds = tasks.map((t) => t.id);
  const selectionAllSelected = allTaskIds.length > 0 && allTaskIds.every((id) => selectedIds.has(id));

  return (
    <div className="flex flex-col h-full bg-neutral-surface overflow-hidden relative">
      <Toolbar
        mode={mode} onModeChange={handleModeChange}
        groupBy={groupBy} onGroupByChange={handleGroupByChange}
        agileFeatures={agileFeatures}
        searchDraft={searchDraft} onSearchChange={handleSearchChange}
        filteredCount={filteredCount} totalCount={tasks.length}
        deletePhase={deletePhase}
        selectedSize={selectedIds.size}
        allSelected={selectionAllSelected || allSelected}
        onSelectAll={() => (selectionAllSelected ? clearSelection() : selectAll(allTaskIds))}
        onClearSelection={clearSelection}
        onDeleteClick={handleDeleteClick}
        onConfirmDelete={handleConfirmDelete}
        onCancelDelete={() => setDeletePhase('idle')}
        isDeleting={deletePhase === 'deleting'}
        onAddTask={() => { setAddFormParentId(null); setShowAddForm(true); }}
        onAddChild={() => {
          setAddFormParentId(outlineSelectedTaskId ?? null);
          setShowAddForm(true);
        }}
        showAddChild={mode === 'outline' && !!outlineSelectedTaskId}
        onExpandAll={() => setExpandAllCounter((c) => c + 1)}
        onCollapseAll={() => setCollapseAllCounter((c) => c + 1)}
        onCsvExport={exportFilteredTasks}
        canExport={filteredCount > 0}
      />

      <ChipStrip
        search={search}
        ownerFilter={ownerFilter}
        statusFilter={statusFilter}
        onRemove={(key) => {
          if (key === 'search') { setSearch(''); setSearchDraft(''); }
          if (key === 'owner') setOwnerFilter('');
          if (key === 'status') setStatusFilter('');
        }}
      />

      {mode === 'flat' && (
        <FlatMode filters={filters} onClearFilters={handleClearFilters} />
      )}
      {mode === 'outline' && (
        <OutlineMode
          filters={filters}
          onClearFilters={handleClearFilters}
          expandAllCounter={expandAllCounter}
          collapseAllCounter={collapseAllCounter}
        />
      )}
      {mode === 'grouped' && (
        <GroupedMode
          groupBy={groupBy}
          filters={filters}
          onClearFilters={handleClearFilters}
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
            if (mode !== 'outline') setOutlineSelectedTaskId(null);
          }}
        />
      )}

      {/* Shell-level live region — mode + group-by announcements. */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
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
          {!toast.isError && <span aria-hidden="true" className="text-semantic-on-track">✓</span>}
          {toast.text}
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
}

function Toolbar({
  mode, onModeChange,
  groupBy, onGroupByChange, agileFeatures,
  searchDraft, onSearchChange,
  filteredCount, totalCount,
  deletePhase, selectedSize, allSelected,
  onSelectAll, onDeleteClick, onConfirmDelete, onCancelDelete, isDeleting,
  onAddTask, onAddChild, showAddChild,
  onExpandAll, onCollapseAll,
  onCsvExport, canExport,
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

  const supportsBulkSelect = mode !== 'outline';

  return (
    <div className="flex items-center gap-2 px-3 h-9 border-b border-neutral-border flex-shrink-0 flex-wrap md:flex-nowrap">
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

      <span className="border-r border-neutral-border h-5 mx-1" aria-hidden="true" />

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
          value={searchDraft}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search tasks…"
          aria-label="Search tasks"
          className="
            pl-7 pr-2 h-7 w-52 text-xs rounded border border-neutral-border
            bg-neutral-surface text-neutral-text-primary placeholder:text-neutral-text-secondary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          "
        />
      </div>

      {supportsBulkSelect && (
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
      )}

      {supportsBulkSelect && selectedSize > 0 && (
        <>
          <span className="text-xs text-neutral-text-secondary">{selectedSize} selected</span>
          <button
            type="button"
            onClick={onDeleteClick}
            className="text-xs text-semantic-critical hover:underline
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1"
          >
            Delete
          </button>
        </>
      )}

      <span className="tppm-mono text-xs text-neutral-text-secondary">
        {filteredCount} / {totalCount} shown
      </span>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onAddTask}
        className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
          border border-neutral-border rounded h-7 px-3
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1"
      >
        + Task
      </button>

      {showAddChild && (
        <button
          type="button"
          onClick={onAddChild}
          aria-label="Add child task under selected"
          className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
            border border-neutral-border rounded h-7 px-3
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1"
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
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1"
          >
            ⤢
          </button>
          <button
            type="button"
            onClick={onCollapseAll}
            aria-label="Collapse all"
            className="text-xs text-neutral-text-secondary hover:text-neutral-text-primary
              border border-neutral-border rounded h-7 px-3
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1"
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
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1 transition-colors
        "
      >
        CSV
      </button>
    </div>
  );
}
