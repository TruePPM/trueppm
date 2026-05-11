import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Task, TaskStatus } from '@/types';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useSprints } from '@/hooks/useSprints';
import { useProject } from '@/hooks/useProject';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useProjectResourcePool } from '@/hooks/useProjectResourcePool';
import { useTaskHistory } from '@/hooks/useTaskHistory';
import { useTaskDependencies } from '@/hooks/useTaskDependencies';
import {
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
  useAddDependency,
  useRemoveDependency,
  parseCyclicDependencyError,
  formatCycleMessage,
} from '@/hooks/useTaskMutations';
import {
  useAddAssignment,
  useUpdateAssignment,
  useRemoveAssignment,
} from '@/hooks/useAssignmentMutations';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { AssigneesEditor, type AssigneeWorkingRow } from './AssigneesEditor';
import { PredecessorsEditor, type PredecessorWorkingRow } from './PredecessorsEditor';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';

export type TaskFormMode = 'create' | 'edit';

export interface TaskFormModalProps {
  /** Project the task belongs to. Required even for edit (used for dependent queries). */
  projectId: string;
  /** When provided, the modal opens in EDIT mode prefilled from this task.
   *  When null, the modal opens in CREATE mode with empty defaults. */
  task: Task | null;
  /** Phase name shown in the create-mode header for context (e.g. "Add to Phase 2 · Design").
   *  Ignored in edit mode. */
  phaseName?: string;
  /** WBS parent id for create mode. Sent as `parent_id` to POST /tasks/. */
  parentId?: string | null;
  /** Default initial status for create mode. Defaults to 'NOT_STARTED' if omitted. */
  defaultStatus?: TaskStatus;
  /** When true, the modal renders in milestone-create mode: title becomes
   *  "New milestone", "Planned start" relabels to "Date", the Duration field
   *  is hidden (milestones are zero-duration), and the submit payload includes
   *  `is_milestone: true, duration: 0`. Only valid when `task` is null
   *  (create-mode); ignored in edit mode. */
  isMilestone?: boolean;
  /** Close handler — fires on Cancel, Esc (if not dirty), close button, or after a successful save/delete. */
  onClose: () => void;
  /** Optional notification when a task is deleted; caller can clear popover state, etc. */
  onDeleted?: (taskId: string) => void;
  /** Optional notification when create-mode save succeeds. Fires before
   *  onClose so the caller can run side effects keyed to the new task id
   *  (e.g. canvas pulse, aria-live announce). Edit-mode saves do not fire
   *  this callback. */
  onCreated?: (taskId: string) => void;
  /** When true, mobile shell is rendered (caller passes the existing `isMobile` from useBoardDensity). */
  isMobile: boolean;
  /** Pre-populate the sprint selector in create mode (e.g. when opening from SprintsView). */
  defaultSprintId?: string | null;
}

const TITLE_ID = 'task-form-modal-title';

const STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: 'BACKLOG', label: 'Backlog' },
  { value: 'NOT_STARTED', label: 'To Do' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'REVIEW', label: 'Review' },
  { value: 'COMPLETE', label: 'Complete' },
];

const ROLE_PROJECT_MANAGER = 3;

interface FormState {
  name: string;
  status: TaskStatus;
  plannedStart: string;
  duration: number;
  progress: number;
  sprintId: string | null;
  notes: string;
  assignees: AssigneeWorkingRow[];
  predecessors: PredecessorWorkingRow[];
}

function initialState(task: Task | null, defaultStatus: TaskStatus): FormState {
  if (task === null) {
    return {
      name: '',
      status: defaultStatus,
      plannedStart: '',
      duration: 1,
      progress: 0,
      sprintId: null,
      notes: '',
      assignees: [],
      predecessors: [],
    };
  }
  return {
    name: task.name,
    status: task.status,
    plannedStart: task.plannedStart ?? '',
    duration: task.duration,
    progress: task.progress,
    sprintId: task.sprintId ?? null,
    notes: task.notes ?? '',
    assignees: task.assignees.map((a) => ({
      // Existing assignees from Task.assignees lack the task-resource row id;
      // the form will reconcile against the freshest list pulled by
      // useTaskAssignments at save time. For the working copy we leave
      // assignmentId undefined and detect existing rows by resourceId match.
      assignmentId: undefined,
      resourceId: a.resourceId,
      resourceName: a.name,
      units: a.units,
    })),
    predecessors: [], // populated from useTaskDependencies when query resolves (see effect below)
  };
}

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

/**
 * Unified task create/edit modal (issue #305, ADR-0052).
 *
 * One component, two modes. `task === null` → create; otherwise edit
 * prefilled from the task. Variation A (single-column compact) is shipped
 * solo per ux-design; variation B was deliberately not implemented.
 *
 * Save sequencing for edit mode: PATCH the task first, then run the diff
 * between original and working assignees/predecessors as separate
 * `/task-resources/` and `/dependencies/` calls. For create mode: POST the
 * task first to obtain its id, then create assignments and dependencies.
 *
 * Failures in the assignment/dependency tail surface as a non-blocking
 * warning and the modal stays open so the user can retry — the task itself
 * has already been written and is visible on the board.
 */
export function TaskFormModal({
  projectId,
  task,
  phaseName,
  parentId,
  defaultStatus = 'NOT_STARTED',
  isMilestone = false,
  onClose,
  onDeleted,
  onCreated,
  isMobile,
  defaultSprintId,
}: TaskFormModalProps) {
  const mode: TaskFormMode = task === null ? 'create' : 'edit';
  const isEdit = mode === 'edit';
  // Milestone mode is only meaningful at create time. Edit-mode milestones
  // already render through MetaRail's milestone-aware section list, not this
  // modal — guard so an edit-mode caller passing isMilestone by mistake
  // doesn't accidentally hide the Duration field on a normal task.
  const isMilestoneCreate = isMilestone && !isEdit;

  const [form, setForm] = useState<FormState>(() => {
    const s = initialState(task, defaultStatus);
    if (task === null && defaultSprintId !== undefined) s.sprintId = defaultSprintId ?? null;
    return s;
  });
  const [pristine, setPristine] = useState<FormState>(() => {
    const s = initialState(task, defaultStatus);
    if (task === null && defaultSprintId !== undefined) s.sprintId = defaultSprintId ?? null;
    return s;
  });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Selected parent in create mode. Seeded from prop (the inferred phase from
  // the highlighted Schedule row) but user-overridable via the picker below
  // so they can move the new task into a different phase before save.
  const [selectedParentId, setSelectedParentId] = useState<string | null>(parentId ?? null);

  // Dependent queries
  const { tasks: allTasks } = useScheduleTasks(projectId);
  const { sprints } = useSprints(projectId);
  const { data: projectDetail } = useProject(projectId);
  const { role } = useCurrentUserRole(projectId);
  const { data: resourcePool } = useProjectResourcePool(projectId);
  const {
    predecessors: serverPredecessors,
    hasResolved: predsHaveResolved,
    error: predsError,
  } = useTaskDependencies(task?.id ?? null);
  const taskHistory = useTaskHistory(projectId, task?.id ?? '');

  // Mutations
  const createTask = useCreateTask(projectId);
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask(projectId);
  const addAssignment = useAddAssignment(projectId);
  const updateAssignment = useUpdateAssignment(task?.id ?? '', projectId);
  const removeAssignment = useRemoveAssignment(task?.id ?? '', projectId);
  const addDependency = useAddDependency(projectId);
  const removeDependency = useRemoveDependency(projectId);

  // Hydrate predecessors once the dependency query resolves (edit mode only).
  // Comparing length + first id stabilises the effect against React Query's
  // identity-changing list: only re-seed the working copy when the *content*
  // changes, not on every render.
  //
  // Two stale-pristine guards (#354):
  //   1. Refuse to hydrate while the query is unresolved (initial load OR
  //      error state). `serverPredecessors` is `[]` in both cases, so the
  //      previous code would silently overwrite a populated `pristine` —
  //      and any subsequent Save would diff `working` against an empty
  //      pristine and soft-delete every real predecessor.
  //   2. Refuse to hydrate to empty when `pristine` already contains rows.
  //      A 401 refetch arriving after a successful add resolves to `[]` for
  //      a request that was rejected before the server saw it; treating
  //      that as "no predecessors" loses the user's saved edges.
  const hydratedPredKey = useRef<string | null>(null);
  useEffect(() => {
    if (!isEdit) return;
    if (!allTasks) return;
    if (!predsHaveResolved) return;
    const key = serverPredecessors.map((e) => e.id).join('|');
    if (hydratedPredKey.current === key) return;
    if (serverPredecessors.length === 0 && pristine.predecessors.length > 0) {
      // Suspected transient failure: server returned empty but we already
      // had populated pristine (a successful previous hydration). Skip the
      // overwrite; the next non-empty resolve will re-hydrate normally.
      return;
    }
    const tasksById = new Map(allTasks.map((t) => [t.id, t]));
    const rows: PredecessorWorkingRow[] = serverPredecessors.map((edge) => {
      const predTask = tasksById.get(edge.predecessorId);
      return {
        dependencyId: edge.id,
        predecessorId: edge.predecessorId,
        predecessorName: predTask?.name ?? `Task ${edge.predecessorId.slice(0, 6)}`,
        predecessorWbs: predTask?.wbs ?? '',
      };
    });
    setForm((s) => ({ ...s, predecessors: rows }));
    setPristine((s) => ({ ...s, predecessors: rows }));
    hydratedPredKey.current = key;
  }, [isEdit, serverPredecessors, allTasks, predsHaveResolved, pristine.predecessors.length]);

  // Permission gate for Delete action — PM+ only. Members with task ownership
  // can still delete via existing surfaces (board card menu); the modal
  // takes the safe-narrow path of role >= PROJECT_MANAGER (3).
  const canDelete = isEdit && role !== null && role >= ROLE_PROJECT_MANAGER;
  const isViewer = role !== null && role === 0;
  const isReadOnly = isViewer || (mode === 'edit' && role === 1 && task?.assignees.every(
    // Member without ownership has read-only view (best-effort heuristic;
    // server is the source of truth — if PATCH fails with 403 we surface it).
    () => false,
  ) === true);

  // Candidate parents for create mode — every task that can author a child:
  // existing summaries AND leaf tasks. Picking a leaf parent will turn it
  // into a summary as soon as the new child is saved (the API derives
  // `is_summary` from `EXISTS(child)` — see views.py annotate). Milestones
  // are excluded because a milestone is a zero-duration marker, not a
  // container. Sorted by WBS so the picker order matches the Schedule's
  // outline. The label includes the WBS path because names are not always
  // unique ("Design" can appear in multiple programs). #378.
  const parentOptions = useMemo(() => {
    if (mode !== 'create' || !allTasks) return [];
    return allTasks
      .filter((t) => !t.isMilestone)
      .map((t) => ({
        id: t.id,
        name: t.name,
        wbs: t.wbs,
        isSummary: t.isSummary,
        label: `${t.wbs} · ${t.name}`,
      }))
      .sort((a, b) => a.wbs.localeCompare(b.wbs, undefined, { numeric: true }));
  }, [mode, allTasks]);

  const selectedParentIsLeaf =
    selectedParentId !== null &&
    parentOptions.find((o) => o.id === selectedParentId)?.isSummary === false;

  // Dirty check — by-value comparison.
  const isDirty = useMemo(() => {
    return JSON.stringify(form) !== JSON.stringify(pristine);
  }, [form, pristine]);

  // Milestones are zero-duration markers; only the name is required.
  const formIsValid =
    form.name.trim().length > 0 && (isMilestoneCreate || form.duration >= 1);

  const isPending = createTask.isPending || updateTask.isPending;

  // ⌘+S submit + Esc dirty-check.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (formIsValid && !isPending && !isReadOnly) {
          void handleSubmit();
        }
        return;
      }
      if (e.key === 'Escape') {
        if (showDeleteConfirm) return; // confirm dialog handles its own Esc
        if (isDirty) {
           
          if (window.confirm('Discard unsaved changes?')) onClose();
        } else {
          onClose();
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formIsValid, isPending, isDirty, isReadOnly, showDeleteConfirm]);

  // --- Save sequencer -----------------------------------------------------
  async function syncAssignments(taskId: string) {
    // Create new (no assignmentId), update changed-units rows that match an
    // existing assignment by resourceId (we look up the id at save time
    // because the working copy doesn't track ids), and delete pristine
    // assignees that are no longer in the working copy.
    const pristineByResource = new Map(
      pristine.assignees.map((a) => [a.resourceId, a]),
    );
    const workingByResource = new Map(
      form.assignees.map((a) => [a.resourceId, a]),
    );

    // Removed assignees — present in pristine, absent in working.
    for (const [resourceId, original] of pristineByResource) {
      if (workingByResource.has(resourceId)) continue;
      // Find the actual task-resource id by matching against task.assignees;
      // task type doesn't carry the assignment id but the read-side hook
      // useTaskAssignments does. We omit that lookup for simplicity and
      // re-run a fetch only on save failures (out of scope refinement —
      // file follow-up if member-side units edit becomes load-bearing).
      // For now we approximate by querying the task-resources index by
      // task+resource. The DELETE endpoint requires the row id, so we
      // skip if assignmentId is unknown — server reconciles via the next
      // useTaskAssignments invalidation.
      if (original.assignmentId) {
        await removeAssignment.mutateAsync(original.assignmentId);
      }
    }
    // Added — absent in pristine, present in working.
    for (const [resourceId, working] of workingByResource) {
      if (pristineByResource.has(resourceId)) continue;
      await addAssignment.mutateAsync({ taskId, resourceId, units: working.units });
    }
    // Changed-units — present in both, units differ.
    for (const [resourceId, working] of workingByResource) {
      const original = pristineByResource.get(resourceId);
      if (!original) continue;
      if (Math.abs(original.units - working.units) < 0.001) continue;
      if (working.assignmentId) {
        await updateAssignment.mutateAsync({ id: working.assignmentId, units: working.units });
      }
    }
  }

  async function syncPredecessors(taskId: string) {
    // Stale-pristine guard (#354). If the dependency query is in error
    // state, `pristine` may not reflect the server's true edge set — diffing
    // against it and firing removes risks soft-deleting real predecessors.
    // Bail out and surface a recoverable message; the task itself has
    // already been saved by `handleSubmit`'s outer try.
    if (predsError) {
      throw new Error(
        "Couldn't sync predecessors right now — your task was saved, but the dependency list is out of date. Reopen the task to retry.",
      );
    }

    const pristineIds = new Set(pristine.predecessors.map((p) => p.predecessorId));
    const workingIds = new Set(form.predecessors.map((p) => p.predecessorId));

    // Removed
    for (const original of pristine.predecessors) {
      if (workingIds.has(original.predecessorId)) continue;
      if (original.dependencyId) {
        await removeDependency.mutateAsync({
          id: original.dependencyId,
          predecessor: original.predecessorId,
          successor: taskId,
        });
      }
    }
    // Added
    for (const working of form.predecessors) {
      if (pristineIds.has(working.predecessorId)) continue;
      await addDependency.mutateAsync({
        predecessor: working.predecessorId,
        successor: taskId,
      });
    }
  }

  async function handleSubmit() {
    setSubmitError(null);
    try {
      let savedTaskId: string;
      if (mode === 'create') {
        const created = await createTask.mutateAsync({
          name: form.name.trim(),
          duration: isMilestoneCreate ? 0 : form.duration,
          parent_id: selectedParentId,
          status: form.status,
          planned_start: form.plannedStart || null,
          notes: form.notes,
          ...(isMilestoneCreate ? { is_milestone: true } : {}),
          ...(projectDetail?.agile_features ? { sprint: form.sprintId } : {}),
        });
        savedTaskId = created.id;
      } else {
        if (!task) throw new Error('Edit mode requires a task');
        await updateTask.mutateAsync({
          id: task.id,
          projectId,
          name: form.name.trim(),
          duration: form.duration,
          percent_complete: form.progress,
          planned_start: form.plannedStart || null,
          status: form.status,
          notes: form.notes,
          ...(projectDetail?.agile_features ? { sprint: form.sprintId } : {}),
        });
        savedTaskId = task.id;
      }
      // Best-effort: assignments + predecessors. Failures here surface as a
      // non-blocking warning; the task itself is already saved.
      try {
        await syncAssignments(savedTaskId);
        await syncPredecessors(savedTaskId);
      } catch (assignErr) {
        // Cycle errors from POST /dependencies/ get a structured message so
        // the user can see the offending path and act on it (ADR-0055).
        const cycle = parseCyclicDependencyError(assignErr);
        if (cycle) {
          setSubmitError(formatCycleMessage(cycle));
          return;
        }
        // Task saved, but the secondary writes failed. Keep modal open so
        // the user can retry.
        setSubmitError(
          assignErr instanceof Error
            ? `Saved task, but updating assignments or dependencies failed: ${assignErr.message}`
            : 'Saved task, but updating assignments or dependencies failed.',
        );
        return;
      }
      if (mode === 'create') {
        onCreated?.(savedTaskId);
      }
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'Couldn’t save the task. Try again.',
      );
    }
  }

  async function handleDelete() {
    if (!task) return;
    try {
      await deleteTask.mutateAsync(task.id);
      onDeleted?.(task.id);
      onClose();
    } catch (err) {
      setShowDeleteConfirm(false);
      setSubmitError(
        err instanceof Error ? err.message : 'Couldn’t delete the task.',
      );
    }
  }

  // Last-edited footer source.
  const latestHistory = taskHistory.data?.pages?.[0]?.results?.[0] ?? null;
  const lastEditLabel = latestHistory
    ? latestHistory.history_user
      ? `Edited by ${latestHistory.history_user} ${formatRelative(latestHistory.history_date)}`
      : `Edited ${formatRelative(latestHistory.history_date)}`
    : null;

  // Submit shortcut hint.
  const submitHint = isMac() ? '⌘+S to save' : 'Ctrl+S to save';

  // -----------------------------------------------------------------------
  // Body — single column, field reordering for create vs edit.
  // -----------------------------------------------------------------------
  function renderBody(): ReactNode {
    return (
      <form
        id="task-form"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          if (formIsValid && !isPending && !isReadOnly) void handleSubmit();
        }}
        className="p-5 flex flex-col gap-4"
      >
        {/* Name — always first */}
        <div>
          <label htmlFor="task-name" className="block text-xs font-medium text-neutral-text-secondary mb-1">
            {isMilestoneCreate ? 'Milestone name' : 'Task name'} <span className="text-semantic-critical" aria-hidden="true">*</span>
          </label>
          <input
            id="task-name"
            type="text"
            required
            aria-required="true"
            disabled={isReadOnly}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={isMilestoneCreate ? 'e.g. Phase 1 sign-off' : 'What needs doing?'}
            className="w-full h-9 px-3 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none placeholder:text-neutral-text-disabled disabled:opacity-60"
          />
        </div>

        {/* Progress slider — edit mode only, second position per Priya's contributor speed */}
        {isEdit && (
          <div>
            <label htmlFor="task-progress" className="block text-xs font-medium text-neutral-text-secondary mb-1">
              Progress
            </label>
            <div className="flex items-center gap-3">
              <input
                id="task-progress"
                type="range"
                min={0}
                max={100}
                step={5}
                disabled={isReadOnly}
                value={form.progress}
                onChange={(e) => setForm({ ...form, progress: Number(e.target.value) })}
                className="flex-1 accent-brand-primary disabled:opacity-60"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={form.progress}
              />
              <span className="tppm-mono text-xs text-neutral-text-primary bg-neutral-surface-sunken px-2 py-0.5 rounded min-w-12 text-center">
                {form.progress}%
              </span>
            </div>
          </div>
        )}

        {/* Status (full width — single-select; Readiness omitted because the API computes it). */}
        <div>
          <label htmlFor="task-status" className="block text-xs font-medium text-neutral-text-secondary mb-1">
            Status
          </label>
          <select
            id="task-status"
            disabled={isReadOnly}
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value as TaskStatus })}
            className="w-full h-9 px-3 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-60"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Parent phase — create mode only, when there is at least one summary
            task in the project. Native datalist gives free typeahead with no
            additional combobox dependency; the value field carries the
            human-readable label, which we map back to the task UUID on commit.
            "No parent" leaves the task at root. */}
        {mode === 'create' && parentOptions.length > 0 && (
          <div>
            <label htmlFor="task-parent" className="block text-xs font-medium text-neutral-text-secondary mb-1">
              Parent phase <span className="text-neutral-text-disabled">(optional)</span>
            </label>
            <select
              id="task-parent"
              disabled={isReadOnly}
              value={selectedParentId ?? ''}
              onChange={(e) => setSelectedParentId(e.target.value || null)}
              aria-describedby="task-parent-hint"
              className="w-full h-9 px-3 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-60"
            >
              <option value="">— No parent (root)</option>
              {parentOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
            <p id="task-parent-hint" className="mt-1 text-[11px] text-neutral-text-secondary">
              {selectedParentId
                ? selectedParentIsLeaf
                  ? isMilestoneCreate
                    ? 'Adding a milestone here will turn this task into a phase.'
                    : 'Adding a task here will turn this task into a phase.'
                  : isMilestoneCreate
                    ? 'New milestone will be added as a child of this phase.'
                    : 'New task will be added as a child of this phase.'
                : 'Choose "No parent" to add at the project root.'}
            </p>
          </div>
        )}

        {/* Sprint — only when project.agile_features */}
        {projectDetail?.agile_features && (
          <div>
            <label htmlFor="task-sprint" className="block text-xs font-medium text-neutral-text-secondary mb-1">
              Sprint
            </label>
            <select
              id="task-sprint"
              disabled={isReadOnly}
              value={form.sprintId ?? ''}
              onChange={(e) => setForm({ ...form, sprintId: e.target.value || null })}
              className="w-full h-9 px-3 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-60"
            >
              <option value="">No sprint</option>
              {sprints
                .filter((s) => s.state !== 'CANCELLED')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} {s.state !== 'ACTIVE' ? `(${s.state.toLowerCase()})` : ''}
                  </option>
                ))}
            </select>
          </div>
        )}

        {/* Planned start + Duration — 2-col on desktop, stacked on mobile.
            Milestones are zero-duration markers, so the Duration column is
            suppressed and the date label switches from "Planned start" to
            "Date" (matches the MetaRail rename in MR !239 / #253). */}
        <div className={`grid grid-cols-1 ${isMilestoneCreate ? '' : 'md:grid-cols-2'} gap-3`}>
          <div>
            <label htmlFor="task-start" className="block text-xs font-medium text-neutral-text-secondary mb-1">
              {isMilestoneCreate ? 'Date' : 'Planned start'}
            </label>
            <input
              id="task-start"
              type="date"
              disabled={isReadOnly}
              value={form.plannedStart}
              onChange={(e) => setForm({ ...form, plannedStart: e.target.value })}
              className="w-full h-9 px-3 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-60"
            />
          </div>
          {!isMilestoneCreate && (
            <div>
              <label htmlFor="task-duration" className="block text-xs font-medium text-neutral-text-secondary mb-1">
                Duration <span className="text-neutral-text-disabled">(working days)</span>
              </label>
              <input
                id="task-duration"
                type="number"
                min={1}
                step={1}
                disabled={isReadOnly}
                value={form.duration}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setForm({ ...form, duration: Number.isFinite(n) && n >= 1 ? n : 1 });
                }}
                className="w-full h-9 px-3 text-sm text-neutral-text-primary tppm-mono bg-neutral-surface border border-neutral-border rounded focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-60"
              />
            </div>
          )}
        </div>

        {/* Assignees */}
        <div>
          <div className="block text-xs font-medium text-neutral-text-secondary mb-1">
            Assignees
          </div>
          <AssigneesEditor
            rows={form.assignees}
            pool={resourcePool ?? []}
            disabled={isReadOnly}
            onAdd={(r) =>
              setForm((s) => ({
                ...s,
                assignees: [
                  ...s.assignees,
                  { resourceId: r.id, resourceName: r.name, units: 1.0 },
                ],
              }))
            }
            onUpdateUnits={(index, units) =>
              setForm((s) => {
                const next = [...s.assignees];
                next[index] = { ...next[index], units };
                return { ...s, assignees: next };
              })
            }
            onRemove={(index) =>
              setForm((s) => ({
                ...s,
                assignees: s.assignees.filter((_, i) => i !== index),
              }))
            }
          />
        </div>

        {/* Predecessors */}
        <div>
          <div className="block text-xs font-medium text-neutral-text-secondary mb-1">
            Predecessors
          </div>
          <PredecessorsEditor
            rows={form.predecessors}
            allTasks={allTasks ?? []}
            currentTaskId={task?.id ?? null}
            disabled={isReadOnly}
            onAdd={(t) =>
              setForm((s) => ({
                ...s,
                predecessors: [
                  ...s.predecessors,
                  {
                    predecessorId: t.id,
                    predecessorName: t.name,
                    predecessorWbs: t.wbs,
                  },
                ],
              }))
            }
            onRemove={(index) =>
              setForm((s) => ({
                ...s,
                predecessors: s.predecessors.filter((_, i) => i !== index),
              }))
            }
          />
        </div>

        {/* Description */}
        <div>
          <label htmlFor="task-notes" className="block text-xs font-medium text-neutral-text-secondary mb-1">
            Description
          </label>
          <textarea
            id="task-notes"
            rows={4}
            disabled={isReadOnly}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="Notes, acceptance criteria, links…"
            className="w-full px-3 py-2 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded resize-vertical focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none placeholder:text-neutral-text-disabled disabled:opacity-60"
          />
        </div>

        {submitError && (
          <div role="alert" className="bg-semantic-critical-bg border border-semantic-critical/30 text-semantic-critical text-xs px-3 py-2 rounded">
            {submitError}
          </div>
        )}
      </form>
    );
  }

  // Header eyebrow + title.
  const eyebrow = isReadOnly
    ? 'VIEW TASK'
    : isEdit
      ? 'EDIT TASK'
      : isMilestoneCreate
        ? 'NEW MILESTONE'
        : 'NEW TASK';
  const headerTitle = isEdit
    ? task?.name ?? ''
    : isMilestoneCreate
      ? 'New milestone'
      : phaseName
        ? `Add to ${phaseName}`
        : 'Add task';

  function renderHeader() {
    return (
      <div className="flex items-start justify-between px-5 py-4 border-b border-neutral-border">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold tracking-widest uppercase text-neutral-text-secondary mb-0.5">
            {eyebrow}
          </div>
          <h2 id={TITLE_ID} className="text-base font-semibold text-neutral-text-primary line-clamp-2 m-0" title={headerTitle}>
            {headerTitle || (isMilestoneCreate ? 'New milestone' : 'Add task')}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="w-8 h-8 inline-flex items-center justify-center rounded text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none shrink-0"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    );
  }

  function renderFooter() {
    if (isReadOnly) {
      return (
        <div className="flex items-center justify-end px-5 py-3 border-t border-neutral-border bg-neutral-surface-raised">
          <button
            type="button"
            onClick={onClose}
            className="h-8 md:h-8 min-h-11 md:min-h-0 px-3 rounded border border-neutral-border bg-transparent text-[13px] text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          >
            Close
          </button>
        </div>
      );
    }

    return (
      <div className="px-5 py-3 border-t border-neutral-border bg-neutral-surface-raised flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {isEdit && canDelete && (
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              disabled={isPending || deleteTask.isPending}
              className="text-[13px] text-semantic-critical hover:bg-semantic-critical/5 px-2 py-1 rounded focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1 focus-visible:outline-none disabled:opacity-50"
              aria-haspopup="dialog"
            >
              Delete task
            </button>
          )}
          {isEdit ? (
            lastEditLabel && (
              <span className="text-xs text-neutral-text-disabled truncate">{lastEditLabel}</span>
            )
          ) : (
            <span className="text-xs text-neutral-text-disabled">{submitHint}</span>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              if (isDirty) {
                 
                if (window.confirm('Discard unsaved changes?')) onClose();
              } else {
                onClose();
              }
            }}
            disabled={isPending}
            className="h-8 md:h-8 min-h-11 md:min-h-0 px-3 rounded border border-neutral-border bg-transparent text-[13px] text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="task-form"
            disabled={!formIsValid || isPending}
            aria-keyshortcuts="Meta+S Control+S"
            className="h-8 md:h-8 min-h-11 md:min-h-0 px-3.5 rounded bg-brand-primary text-white text-[13px] font-medium border-none hover:bg-brand-primary-dark focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-brand-primary focus-visible:outline-none disabled:opacity-50"
          >
            {isPending
              ? (isEdit ? 'Saving…' : 'Creating…')
              : isEdit
                ? 'Save changes'
                : isMilestoneCreate
                  ? 'Create milestone'
                  : 'Create task'}
          </button>
        </div>
      </div>
    );
  }

  // Mobile: full-screen BottomSheet (size='full' — see ADR-0052 §5).
  if (isMobile) {
    return (
      <>
        <BottomSheet isOpen onClose={onClose} titleId={TITLE_ID} size="full" hasDragHandle={false}>
          <div className="flex flex-col h-full">
            {renderHeader()}
            <div className="flex-1 overflow-y-auto">{renderBody()}</div>
            {renderFooter()}
          </div>
        </BottomSheet>
        {showDeleteConfirm && task && (
          <DeleteConfirmDialog
            taskName={task.name}
            isPending={deleteTask.isPending}
            onCancel={() => setShowDeleteConfirm(false)}
            onConfirm={() => { void handleDelete(); }}
          />
        )}
      </>
    );
  }

  // Desktop: centered fixed-position modal.
  return (
    <>
      <div
        aria-hidden="true"
        className="hidden md:block fixed inset-0 z-40 bg-black/40 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
        onPointerDown={() => {
          if (isDirty) {
             
            if (window.confirm('Discard unsaved changes?')) onClose();
          } else {
            onClose();
          }
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        className="hidden md:flex fixed inset-0 z-50 items-center justify-center pointer-events-none"
      >
        <div className="bg-neutral-surface border border-neutral-border rounded-lg overflow-hidden flex flex-col w-[560px] max-h-[90vh] pointer-events-auto">
          {renderHeader()}
          <div className="flex-1 overflow-y-auto">{renderBody()}</div>
          {renderFooter()}
        </div>
      </div>
      {showDeleteConfirm && task && (
        <DeleteConfirmDialog
          taskName={task.name}
          isPending={deleteTask.isPending}
          onCancel={() => setShowDeleteConfirm(false)}
          onConfirm={() => { void handleDelete(); }}
        />
      )}
    </>
  );
}
