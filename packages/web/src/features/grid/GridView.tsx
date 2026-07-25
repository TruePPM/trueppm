import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
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
import { GridEmptyState, GridFilteredEmptyState } from './GridEmptyState';
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
import { emptyFilters, matchesFilters, type GridFilterState } from './filters';
import { CheckIcon } from '@/components/Icons';
import { LabelFacet } from '@/components/filters/LabelFacet';
import { OwnerFacet } from '@/components/filters/OwnerFacet';
import { StatusFacet } from '@/components/filters/StatusFacet';
import {
  LABEL_PARAM,
  countTasksByLabel,
  parseLabelIds,
  pruneUnknownLabelIds,
  serializeLabelIds,
} from '@/components/filters/labelFilter';
import {
  OWNER_PARAM,
  STATUS_PARAM,
  parseIdList,
  serializeIdList,
} from '@/components/filters/facetParams';
import { countTasksByOwner, ownerDisplayName } from '@/components/filters/ownerFilter';
import {
  countTasksByStatus,
  parseStatuses,
  statusDisplayName,
} from '@/components/filters/statusFilter';
import { useLabels } from '@/hooks/useLabels';
import { useProjectResourcePool } from '@/hooks/useProjectResourcePool';
import { useFilterAnnouncement } from '@/hooks/useFilterAnnouncement';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';

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
  const navigate = useNavigate();

  // Filter state — search, owner, status, due. Seeded from the URL; owner+status
  // also set programmatically; the chip strip exposes the active set with × to
  // clear individual filters.
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '');
  const [searchDraft, setSearchDraft] = useState(() => searchParams.get('q') ?? '');
  // Owner and Status are multi-select as of #2387 (ADR-0624). A pre-existing
  // single-value link is a one-item list, so `?owner=Alice&status=IN_PROGRESS`
  // parses and resolves exactly as it did before.
  const [ownerIds, setOwnerIds] = useState(() => parseIdList(searchParams.get(OWNER_PARAM)));
  const [statuses, setStatuses] = useState<TaskStatus[]>(() =>
    parseStatuses(parseIdList(searchParams.get(STATUS_PARAM))),
  );
  // Label facet (`?fl=`, ADR-0620). The param name is the Board's, adopted
  // verbatim so one bookmark format works on every view — and this is purely
  // additive: an existing `?owner=…&status=…` link with no `fl` is untouched.
  const [labelIds, setLabelIds] = useState(() => parseLabelIds(searchParams.get(LABEL_PARAM)));
  const ownerTriggerRef = useRef<HTMLButtonElement>(null);
  const statusTriggerRef = useRef<HTMLButtonElement>(null);
  const labelTriggerRef = useRef<HTMLButtonElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One panel at a time: opening Status closes Owner. Held here rather than in
  // each facet because only the shared parent can know a sibling opened.
  const [openFacet, setOpenFacet] = useState<'owner' | 'status' | 'label' | null>(null);

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
        setParam(OWNER_PARAM, serializeIdList(ownerIds));
        setParam(STATUS_PARAM, serializeIdList(statuses));
        setParam(LABEL_PARAM, serializeLabelIds(labelIds));
        return next;
      },
      { replace: true },
    );
  }, [search, ownerIds, statuses, labelIds, setSearchParams]);

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

  // The project's label catalog drives the facet's option list (every label,
  // including ones on no loaded row — decision 2). Counts are computed over the
  // loaded rows, not read from the catalog's server-side `taskCount`, so the
  // number answers "how many rows *here*" and a visible 0 is truthful.
  const { data: labelCatalog } = useLabels(projectId ?? undefined);
  const labels = useMemo(() => labelCatalog ?? [], [labelCatalog]);
  const labelCounts = useMemo(
    () =>
      countTasksByLabel(
        tasks ?? [],
        labels.map((l) => l.id),
      ),
    [tasks, labels],
  );

  // A label deleted while a `?fl=` link still names it must not silently filter
  // everything out. Prune at the point of *application* only — the stored/URL
  // value is left alone so a shared link stays diagnosable.
  const appliedLabelIds = useMemo(
    () =>
      pruneUnknownLabelIds(
        labelIds,
        labels.map((l) => l.id),
      ),
    [labelIds, labels],
  );

  // The Owner facet's catalog is the project's resource pool — everyone who
  // *could* own work here, not just the assignees on the loaded rows. Same
  // contract as Label: a member with zero rows is visible, with a truthful `0`,
  // before you select them (ADR-0624).
  const { data: resourcePool } = useProjectResourcePool(projectId ?? '');
  const ownerCandidates = useMemo(
    () => (resourcePool ?? []).map((r) => ({ id: r.resourceId, name: r.resource.name })),
    [resourcePool],
  );
  const ownerCounts = useMemo(
    () =>
      countTasksByOwner(
        tasks ?? [],
        ownerCandidates.map((c) => c.id),
      ),
    [tasks, ownerCandidates],
  );
  const statusCounts = useMemo(() => countTasksByStatus(tasks ?? []), [tasks]);

  const filters: GridFilterState = useMemo(
    () => ({
      search,
      ownerIds,
      statuses,
      dueFilter: overdue ? 'overdue' : 'all',
      labelIds: appliedLabelIds,
    }),
    [search, ownerIds, statuses, overdue, appliedLabelIds],
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

  // "Clear all" — every facet, labels included, so the strip unmounts entirely
  // and reclaims its row-2 height.
  const handleClearFilters = () => {
    setSearch('');
    setSearchDraft('');
    setOwnerIds([]);
    setStatuses([]);
    setOverdue(false);
    setLabelIds([]);
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

  // Active label chips for the strip, in selection order. Built from the *applied*
  // ids so a `?fl=` naming a deleted label does not render a nameless chip.
  const labelChips = useMemo(
    () =>
      appliedLabelIds.flatMap((id) => {
        const label = labels.find((l) => l.id === id);
        return label
          ? [{ id, name: label.name, color: label.color, count: labelCounts[id] ?? 0 }]
          : [];
      }),
    [appliedLabelIds, labels, labelCounts],
  );

  const ownerChips = useMemo(
    () => ownerIds.map((id) => ({ id, name: ownerDisplayName(id, ownerCandidates) })),
    [ownerIds, ownerCandidates],
  );
  const statusChips = useMemo(
    () => statuses.map((id) => ({ id, name: statusDisplayName(id) })),
    [statuses],
  );

  // Announce the outcome once the user stops clicking, not once per selection.
  // The tail names *how many of each* facet rather than listing every value:
  // "2 owners, 1 status, 1 label" is the shape of the filter, which is what a
  // screen-reader user needs after a burst of toggles — the values themselves
  // are already in the chip strip.
  const online = useOnlineStatus();
  const hasFacetFilter =
    ownerIds.length > 0 || statuses.length > 0 || appliedLabelIds.length > 0;
  // Below md the popover has nowhere to go on a 428px toolbar, so each trigger
  // opens the same panel body inside a bottom sheet instead.
  const facetPresentation = isMobile ? 'sheet' : 'popover';
  const facetSummary = [
    ownerIds.length > 0 ? `${ownerIds.length} owner${ownerIds.length === 1 ? '' : 's'}` : null,
    statuses.length > 0 ? `${statuses.length} status${statuses.length === 1 ? '' : 'es'}` : null,
    appliedLabelIds.length > 0
      ? `${appliedLabelIds.length} label${appliedLabelIds.length === 1 ? '' : 's'}`
      : null,
  ]
    .filter(Boolean)
    .join(', ');
  const announcement = useFilterAnnouncement(
    facetSummary && tasks ? `${filteredCount} of ${tasks.length} rows — ${facetSummary}` : '',
  );

  /**
   * Per-facet diagnosis for the zero-result state. `standalone` is how many rows
   * the facet keeps on its own; `recovered` is how many come back if it alone is
   * dropped — the empty state offers the drop that recovers the most, which is
   * the click most likely to be what the user wanted.
   *
   * Computed only when the result set is actually empty and more than one facet
   * is active, so the extra passes over `tasks` never run on the common path.
   */
  const emptyStateFacets = useMemo(() => {
    if (!tasks || filteredCount > 0) return [];
    const base = emptyFilters();
    const active: {
      key: string;
      label: string;
      only: Partial<GridFilterState>;
      clear: Partial<GridFilterState>;
      onDrop: () => void;
    }[] = [];
    if (search)
      active.push({
        key: 'search',
        label: `"${search}"`,
        only: { search },
        clear: { search: '' },
        onDrop: () => {
          setSearch('');
          setSearchDraft('');
        },
      });
    if (ownerIds.length > 0)
      active.push({
        key: 'owner',
        label: `Owner: ${summarizeValues(ownerChips.map((c) => c.name))}`,
        only: { ownerIds },
        clear: { ownerIds: [] },
        onDrop: () => setOwnerIds([]),
      });
    if (statuses.length > 0)
      active.push({
        key: 'status',
        label: `Status: ${summarizeValues(statusChips.map((c) => c.name))}`,
        only: { statuses },
        clear: { statuses: [] },
        onDrop: () => setStatuses([]),
      });
    if (appliedLabelIds.length > 0)
      active.push({
        key: 'label',
        label: `Label: ${summarizeValues(labelChips.map((c) => c.name))}`,
        only: { labelIds: appliedLabelIds },
        clear: { labelIds: [] },
        onDrop: () => setLabelIds([]),
      });
    if (overdue)
      active.push({
        key: 'overdue',
        label: 'Overdue',
        only: { dueFilter: 'overdue' as const },
        clear: { dueFilter: 'all' as const },
        onDrop: () => setOverdue(false),
      });
    if (active.length < 2) return [];
    return active.map((f) => ({
      key: f.key,
      label: f.label,
      standaloneCount: tasks.filter((t) => matchesFilters(t, { ...base, ...f.only })).length,
      recoveredCount: tasks.filter((t) => matchesFilters(t, { ...filters, ...f.clear })).length,
      onDrop: f.onDrop,
    }));
  }, [
    tasks,
    filteredCount,
    filters,
    search,
    ownerIds,
    statuses,
    appliedLabelIds,
    overdue,
    ownerChips,
    statusChips,
    labelChips,
    setOverdue,
  ]);

  const filteredEmptyState = (
    <GridFilteredEmptyState onClear={handleClearFilters} facets={emptyStateFacets} />
  );

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
        facets={
          <>
            {/* Owner · Status · Label, left→right — the same order the chip
                strip lists them in below. One `openFacet` means opening any of
                the three closes the other two. */}
            <OwnerFacet
              triggerRef={ownerTriggerRef}
              candidates={ownerCandidates}
              counts={ownerCounts}
              selected={ownerIds}
              onChange={setOwnerIds}
              open={openFacet === 'owner'}
              onOpenChange={(next) => setOpenFacet(next ? 'owner' : null)}
              presentation={facetPresentation}
            />
            <StatusFacet
              triggerRef={statusTriggerRef}
              counts={statusCounts}
              selected={statuses}
              onChange={setStatuses}
              open={openFacet === 'status'}
              onOpenChange={(next) => setOpenFacet(next ? 'status' : null)}
              presentation={facetPresentation}
            />
            <LabelFacet
              triggerRef={labelTriggerRef}
              labels={labels}
              counts={labelCounts}
              selected={labelIds}
              onChange={setLabelIds}
              open={openFacet === 'label'}
              onOpenChange={(next) => setOpenFacet(next ? 'label' : null)}
              presentation={facetPresentation}
              onOpenLabelSettings={
                projectId ? () => void navigate(`/projects/${projectId}/settings/labels`) : undefined
              }
            />
          </>
        }
        canEdit={canEdit}
      />

      {/* Polite live region for the filter outcome. Rendered unconditionally so
          the node exists before the first announcement — a live region added to
          the DOM at the same moment it gains text is not reliably announced. */}
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>

      <ChipStrip
        search={search}
        ownerChips={ownerChips}
        statusChips={statusChips}
        labelChips={labelChips}
        overdue={overdue}
        ownerTriggerRef={ownerTriggerRef}
        statusTriggerRef={statusTriggerRef}
        labelTriggerRef={labelTriggerRef}
        note={
          !online && hasFacetFilter && tasks
            ? `Offline — filtering the ${tasks.length} rows already loaded`
            : undefined
        }
        onRemoveSearch={() => {
          setSearch('');
          setSearchDraft('');
        }}
        onRemoveOwner={(id) => setOwnerIds((prev) => prev.filter((v) => v !== id))}
        onRemoveStatus={(id) => setStatuses((prev) => prev.filter((v) => v !== id))}
        onRemoveLabel={(id) => setLabelIds((prev) => prev.filter((v) => v !== id))}
        onRemoveOverdue={() => setOverdue(false)}
        onClearAll={handleClearFilters}
      />

      {effectiveMode === 'flat' && (
        <FlatMode
          filters={filters}
          onClearFilters={handleClearFilters}
          filteredEmptyState={filteredEmptyState}
          onOpenDetail={handleOpenDetail}
          canEdit={canEdit}
        />
      )}
      {effectiveMode === 'outline' && (
        <OutlineMode
          filters={filters}
          onClearFilters={handleClearFilters}
          filteredEmptyState={filteredEmptyState}
          expandAllCounter={expandAllCounter}
          collapseAllCounter={collapseAllCounter}
        />
      )}
      {effectiveMode === 'grouped' && (
        <GroupedMode
          groupBy={groupBy}
          filters={filters}
          onClearFilters={handleClearFilters}
          filteredEmptyState={filteredEmptyState}
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
            <CheckIcon className="text-semantic-on-track inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
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
  /**
   * The Owner / Status / Label facet triggers, injected rather than constructed
   * here so the Toolbar stays presentational and the catalog/count/open-state
   * wiring lives with the rest of the filter state.
   */
  facets?: ReactNode;
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
  facets,
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

      {/* Facet cluster sits with the search field, and reads left→right in the
          same order the chip strip below lists them: Owner · Status · Label. */}
      {facets}

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

/**
 * Compact a facet's selected values for a one-line label: the first value, plus
 * `+N` for the rest. Used by the zero-result diagnosis, where naming all five
 * selected owners would bury the sentence it sits in.
 */
function summarizeValues(names: string[]): string {
  if (names.length === 0) return 'any';
  if (names.length === 1) return names[0];
  return `${names[0]} +${names.length - 1}`;
}
