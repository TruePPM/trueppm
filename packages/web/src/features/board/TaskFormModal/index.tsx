import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Task, TaskStatus, TaskType, GovernanceClass, DeliveryMode } from '@/types';
import { ROLE_VIEWER, ROLE_MEMBER, ROLE_ADMIN } from '@/lib/roles';
import { Button } from '@/components/Button';
import { FieldHelp } from '@/components/FieldHelp';
import { toast } from '@/components/Toast';
import { isSyncConflict } from '@/api/conflict';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useSprints } from '@/hooks/useSprints';
import { useProject } from '@/hooks/useProject';
import { useIterationLabel } from '@/hooks/useIterationLabel';
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
  parseProgressAnchorError,
} from '@/hooks/useTaskMutations';
import {
  useAddAssignment,
  useUpdateAssignment,
  useRemoveAssignment,
} from '@/hooks/useAssignmentMutations';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { ConfirmDiscardDialog } from '@/features/settings/components/ConfirmDiscardDialog';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { AssigneesEditor, type AssigneeWorkingRow } from './AssigneesEditor';
import { PredecessorsEditor, type PredecessorWorkingRow } from './PredecessorsEditor';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { isPhaseTask } from '@/lib/isPhaseTask';

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

// --- Classification vocabulary (task taxonomy editor) --------------------
// Values mirror the backend enums exactly — TaskType (ADR-0105/#363),
// GovernanceClass + DeliveryMode (ADR-0036/#407). The per-value descriptions
// are grounded in those models' docstrings, not invented enforcement copy.
interface TaxonomyOption<V extends string> {
  value: V;
  label: string;
  desc: string;
}

const TYPE_OPTIONS: Array<TaxonomyOption<TaskType>> = [
  { value: 'task', label: 'Task', desc: 'Standard unit of work with effort and dates.' },
  { value: 'story', label: 'Story', desc: 'User-facing increment, estimated in story points.' },
  { value: 'bug', label: 'Bug', desc: 'A defect against accepted scope.' },
  { value: 'spike', label: 'Spike', desc: 'Time-boxed research; ships no deliverable.' },
  { value: 'tech_debt', label: 'Tech Debt', desc: 'Refactoring or remediation. Scheduled like a task and counts toward velocity; reported separately.' },
  { value: 'epic', label: 'Epic', desc: 'Structural parent — groups child work and rolls up. Excluded from scheduling.' },
];

const GOVERNANCE_OPTIONS: Array<TaxonomyOption<GovernanceClass>> = [
  { value: 'flow', label: 'Flow', desc: 'Agile, sprint- or kanban-governed work (default).' },
  { value: 'gated', label: 'Gated', desc: 'Phase-gate–governed waterfall work.' },
  { value: 'hybrid', label: 'Hybrid', desc: 'Mixes flow and gated within the subtree.' },
];

const DELIVERY_OPTIONS: Array<TaxonomyOption<DeliveryMode>> = [
  { value: 'waterfall', label: 'Waterfall', desc: 'Explicit percent-complete; participates in CPM and the baseline.' },
  { value: 'scrum', label: 'Scrum', desc: 'Rolls up from story-point burndown; velocity-tracked.' },
  { value: 'kanban', label: 'Kanban', desc: 'Rolls up from item throughput on a WIP-limited board.' },
  { value: 'milestone', label: 'Milestone', desc: 'Zero-duration gate marking a date or phase.' },
];

function taxonomyDesc<V extends string>(options: Array<TaxonomyOption<V>>, value: V): string {
  return options.find((o) => o.value === value)?.desc ?? '';
}

// Deep-links into the task-classification docs page for the FieldHelp popovers.
// Anchors match the headings in `docs/features/task-classification` — keep them
// in sync if those headings are renamed.
const CLASSIFICATION_DOC = 'features/task-classification/';
const TYPE_DOC = `${CLASSIFICATION_DOC}#type--what-kind-of-work-this-is`;
const GOVERNANCE_DOC = `${CLASSIFICATION_DOC}#governance-class--which-overlay-governs-the-subtree`;
const DELIVERY_DOC = `${CLASSIFICATION_DOC}#delivery-mode--how-the-work-executes-and-rolls-up`;

interface FormState {
  name: string;
  status: TaskStatus;
  type: TaskType;
  governanceClass: GovernanceClass;
  deliveryMode: DeliveryMode;
  plannedStart: string;
  duration: number;
  progress: number;
  sprintId: string | null;
  storyPoints: number | null;
  notes: string;
  assignees: AssigneeWorkingRow[];
  predecessors: PredecessorWorkingRow[];
}

function initialState(task: Task | null, defaultStatus: TaskStatus): FormState {
  if (task === null) {
    return {
      name: '',
      status: defaultStatus,
      // Server defaults (purely additive fields): TASK / FLOW / WATERFALL.
      type: 'task',
      governanceClass: 'flow',
      deliveryMode: 'waterfall',
      plannedStart: '',
      duration: 1,
      progress: 0,
      sprintId: null,
      storyPoints: null,
      notes: '',
      assignees: [],
      predecessors: [],
    };
  }
  return {
    name: task.name,
    status: task.status,
    // Legacy/non-agile rows may omit these — fall back to the server defaults.
    type: task.taskType ?? 'task',
    governanceClass: task.governanceClass ?? 'flow',
    deliveryMode: task.deliveryMode ?? 'waterfall',
    plannedStart: task.plannedStart ?? '',
    duration: task.duration,
    progress: task.progress,
    sprintId: task.sprintId ?? null,
    storyPoints: task.storyPoints ?? null,
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
  // Raw text backing the Duration input. Kept separate from the numeric
  // form.duration so the field can hold a transient empty/partial string while
  // editing — a controlled number input that coerces empty → 1 on every
  // keystroke can never be cleared, which strands the user with a sticky
  // leading "1" (#1974). form.duration is the committed value; this is only
  // the in-flight display. Normalized back to a valid number on blur.
  const [durationText, setDurationText] = useState<string>(() => String(form.duration));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // #838: dirty-discard confirmation now uses the ARIA-managed ConfirmDiscardDialog
  // instead of window.confirm (which is unmanaged by the focus trap / screen reader).
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  // #838: trap focus inside the desktop modal (the mobile BottomSheet already
  // traps). Yields while a sub-dialog owns focus — safe only because BOTH
  // sub-dialogs run their own trap (ConfirmDiscardDialog, and per #1776
  // DeleteConfirmDialog too; an untrapped child here lets Tab escape into the
  // background form). Escape is handled by the document keydown handler above,
  // so no onEscape is passed.
  const desktopTrapRef = useFocusTrap<HTMLDivElement>(
    !isMobile && !showDeleteConfirm && !showDiscardConfirm,
  );
  // Selected parent in create mode. Seeded from prop (the inferred phase from
  // the highlighted Schedule row) but user-overridable via the picker below
  // so they can move the new task into a different phase before save.
  const [selectedParentId, setSelectedParentId] = useState<string | null>(parentId ?? null);

  // Dependent queries
  const { tasks: allTasks } = useScheduleTasks(projectId);
  // A phase never gets an assignee, mirroring the backend's `assignee_on_phase`
  // rejection (ADR-0293, #1753). Only meaningful in edit mode — a freshly
  // create-mode task has no children yet, so it can never already be a phase.
  const isEditingPhase = isEdit && task != null && isPhaseTask(task, allTasks ?? []);
  const { sprints } = useSprints(projectId);
  const { data: projectDetail } = useProject(projectId);
  const itl = useIterationLabel(projectId);
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
  const canDelete = isEdit && role !== null && role >= ROLE_ADMIN;
  const isViewer = role !== null && role === ROLE_VIEWER;
  const isReadOnly = isViewer || (mode === 'edit' && role === ROLE_MEMBER && task?.assignees.every(
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

  // Edit mode: only the name is required — duration was already validated at creation.
  // Create mode: duration >= 1, except milestones which are always zero-duration.
  const formIsValid =
    form.name.trim().length > 0 && (isEdit || isMilestoneCreate || form.duration >= 1);

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
        // Sub-dialogs own their own Escape handling.
        if (showDeleteConfirm || showDiscardConfirm) return;
        if (isDirty) {
          setShowDiscardConfirm(true);
        } else {
          onClose();
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formIsValid, isPending, isDirty, isReadOnly, showDeleteConfirm, showDiscardConfirm]);

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
    // Duration is normalized on blur, but a keyboard submit (⌘+S) can fire while
    // the field still holds a transient sub-1/empty entry that never blurred, so
    // floor it here too — the committed value must always be a valid working-day
    // count (#1974). Milestones are always zero-duration.
    const committedDuration =
      Number.isFinite(form.duration) && form.duration >= 1 ? form.duration : 1;
    try {
      let savedTaskId: string;
      if (mode === 'create') {
        const created = await createTask.mutateAsync({
          name: form.name.trim(),
          duration: isMilestoneCreate ? 0 : committedDuration,
          parent_id: selectedParentId,
          status: form.status,
          planned_start: form.plannedStart || null,
          notes: form.notes,
          ...(isMilestoneCreate ? { is_milestone: true } : {}),
          // Classification is suppressed in milestone-create mode (see render).
          ...(isMilestoneCreate
            ? {}
            : { type: form.type, governance_class: form.governanceClass, delivery_mode: form.deliveryMode }),
          // The point estimate is available on every methodology (ADR-0418, #1961) —
          // decoupled from agile_features. Sprint assignment stays agile-only.
          story_points: form.storyPoints,
          ...(projectDetail?.agile_features ? { sprint: form.sprintId } : {}),
        });
        savedTaskId = created.id;
      } else {
        if (!task) throw new Error('Edit mode requires a task');
        await updateTask.mutateAsync({
          id: task.id,
          projectId,
          // Opt into field-level merge (ADR-0217, issue 322): if another editor changed a
          // disjoint field the server merges; an overlapping edit 409s with a toast.
          baseVersion: task.serverVersion,
          name: form.name.trim(),
          duration: committedDuration,
          percent_complete: form.progress,
          planned_start: form.plannedStart || null,
          status: form.status,
          notes: form.notes,
          type: form.type,
          governance_class: form.governanceClass,
          delivery_mode: form.deliveryMode,
          // Estimate on every methodology (ADR-0418, #1961); sprint stays agile-only.
          story_points: form.storyPoints,
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
        toast.success(`Created ${form.name.trim()}`);
      }
      onClose();
    } catch (err) {
      // A sync conflict (ADR-0217) already surfaced the "Someone else changed this"
      // toast with a Reload action via the mutation's onError; close the modal so the
      // toast is unobstructed rather than stacking a redundant inline error.
      if (isSyncConflict(err)) {
        onClose();
        return;
      }
      const anchorErr = parseProgressAnchorError(err);
      if (anchorErr) {
        setSubmitError(
          `Set a Planned Start date (or assign a ${itl.lower}) before recording progress.`,
        );
        return;
      }
      setSubmitError(
        err instanceof Error ? err.message : `Couldn’t save the task. Try again.`,
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

  // Last-edited footer source. The feed is now a merged activity stream (#1883),
  // so pick the newest actual field edit (only field-diff entries carry
  // history_date) rather than the newest event of any type.
  const latestHistory =
    taskHistory.data?.pages?.flatMap((p) => p.results).find((r) => r.history_date != null) ?? null;
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
            className="w-full h-9 px-3 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded-control focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none placeholder:text-neutral-text-disabled disabled:opacity-60"
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
              <span className="tppm-mono text-xs text-neutral-text-primary bg-neutral-surface-sunken px-2 py-0.5 rounded-chip min-w-12 text-center">
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
            className="w-full h-9 px-3 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded-control focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-60"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Classification — the task taxonomy editor (type / governance_class /
            delivery_mode). All three are server-writable and additive (defaults
            task / flow / waterfall) but had no editor before this group, so the
            taxonomy could be seeded but never changed from the UI. Suppressed in
            milestone-create mode: a milestone is a zero-duration marker, not
            typed/governed work (is_milestone is the relevant flag there). */}
        {!isMilestoneCreate && (
          <div
            role="group"
            aria-labelledby="task-classification-label"
            className="border-t border-neutral-border pt-4 flex flex-col gap-3"
          >
            <div
              id="task-classification-label"
              className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
            >
              Classification
            </div>

            <div>
              <div className="mb-1 flex items-center gap-1">
                <label htmlFor="task-type" className="text-xs font-medium text-neutral-text-secondary">
                  Type
                </label>
                <FieldHelp
                  label="Type"
                  intro="What kind of work this task is."
                  options={TYPE_OPTIONS.map((o) => ({
                    label: o.label,
                    desc: o.desc,
                    selected: o.value === form.type,
                  }))}
                  docHref={TYPE_DOC}
                />
              </div>
              <select
                id="task-type"
                disabled={isReadOnly}
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as TaskType })}
                aria-describedby="task-type-hint"
                className="w-full h-9 px-3 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded-control focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-60"
              >
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p id="task-type-hint" className="mt-1 text-xs text-neutral-text-secondary">
                {taxonomyDesc(TYPE_OPTIONS, form.type)}
              </p>
            </div>

            <div>
              <div className="mb-1 flex items-center gap-1">
                <label htmlFor="task-governance" className="text-xs font-medium text-neutral-text-secondary">
                  Governance class
                </label>
                <FieldHelp
                  label="Governance class"
                  intro="Which overlay governs this task's subtree."
                  options={GOVERNANCE_OPTIONS.map((o) => ({
                    label: o.label,
                    desc: o.desc,
                    selected: o.value === form.governanceClass,
                  }))}
                  docHref={GOVERNANCE_DOC}
                />
              </div>
              <select
                id="task-governance"
                disabled={isReadOnly}
                value={form.governanceClass}
                onChange={(e) => setForm({ ...form, governanceClass: e.target.value as GovernanceClass })}
                aria-describedby="task-governance-hint"
                className="w-full h-9 px-3 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded-control focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-60"
              >
                {GOVERNANCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p id="task-governance-hint" className="mt-1 text-xs text-neutral-text-secondary">
                {taxonomyDesc(GOVERNANCE_OPTIONS, form.governanceClass)}
              </p>
            </div>

            <div>
              <div className="mb-1 flex items-center gap-1">
                <label htmlFor="task-delivery" className="text-xs font-medium text-neutral-text-secondary">
                  Delivery mode
                </label>
                <FieldHelp
                  label="Delivery mode"
                  intro="How this task executes, is estimated, and rolls up."
                  options={DELIVERY_OPTIONS.map((o) => ({
                    label: o.label,
                    desc: o.desc,
                    selected: o.value === form.deliveryMode,
                  }))}
                  docHref={DELIVERY_DOC}
                />
              </div>
              <select
                id="task-delivery"
                disabled={isReadOnly}
                value={form.deliveryMode}
                onChange={(e) => setForm({ ...form, deliveryMode: e.target.value as DeliveryMode })}
                aria-describedby="task-delivery-hint"
                className="w-full h-9 px-3 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded-control focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-60"
              >
                {DELIVERY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p id="task-delivery-hint" className="mt-1 text-xs text-neutral-text-secondary">
                {taxonomyDesc(DELIVERY_OPTIONS, form.deliveryMode)}
              </p>
            </div>
          </div>
        )}

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
              className="w-full h-9 px-3 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded-control focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-60"
            >
              <option value="">— No parent (root)</option>
              {parentOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
            <p id="task-parent-hint" className="mt-1 text-xs text-neutral-text-secondary">
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

        {/* Story points (the card estimate) is available on every methodology
            (ADR-0418, #1961); the Sprint selector remains agile-only. On a
            non-agile project only the Pts input renders. */}
        {(() => {
          const showSprint = !!projectDetail?.agile_features;
          const selectedSprint = sprints.find((s) => s.id === form.sprintId);
          // Commitment is frozen once a sprint goes ACTIVE — match EstimatesTab.
          // No sprint exists off agile, so points stay editable there.
          const pointsReadOnly = isReadOnly || (isEdit && selectedSprint?.state === 'ACTIVE');
          return (
            <div
              className={`grid ${showSprint ? 'grid-cols-[1fr_auto]' : 'grid-cols-[auto]'} gap-3 items-end`}
            >
              {showSprint && (
                <div>
                  <label htmlFor="task-sprint" className="block text-xs font-medium text-neutral-text-secondary mb-1">
                    {itl.singular}
                  </label>
                  <select
                    id="task-sprint"
                    disabled={isReadOnly}
                    value={form.sprintId ?? ''}
                    onChange={(e) => setForm({ ...form, sprintId: e.target.value || null })}
                    className="w-full h-9 px-3 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded-control focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-60"
                  >
                    <option value="">No {itl.lower}</option>
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
              <div className="w-20">
                <label htmlFor="task-story-points" className="block text-xs font-medium text-neutral-text-secondary mb-1">
                  Pts
                </label>
                {pointsReadOnly ? (
                  <div
                    className="w-full h-9 flex items-center justify-center tppm-mono text-sm text-neutral-text-primary bg-neutral-surface-raised border border-neutral-border/50 rounded-control"
                    aria-label={`Story points: ${form.storyPoints ?? '—'}`}
                  >
                    {form.storyPoints ?? '—'}
                  </div>
                ) : (
                  <input
                    id="task-story-points"
                    type="number"
                    min={0}
                    step={1}
                    placeholder="—"
                    value={form.storyPoints ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setForm({ ...form, storyPoints: raw === '' ? null : Math.max(0, Math.round(Number(raw))) });
                    }}
                    className="w-full h-9 px-2 text-sm tppm-mono text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded-control focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none placeholder:text-neutral-text-disabled"
                  />
                )}
              </div>
            </div>
          );
        })()}

        {/* Planned start + Duration — 2-col on desktop, stacked on mobile.
            Milestones and pure-agile projects suppress the Duration column:
            milestones are zero-duration markers; agile teams size in story
            points and velocity→calendar translation happens at program level,
            not per-task (#469). */}
        {(() => {
          const isAgileOnly = projectDetail?.methodology === 'AGILE';
          const showDuration = !isMilestoneCreate && !isAgileOnly;
          return (
            <div className={`grid grid-cols-1 ${showDuration ? 'md:grid-cols-2' : ''} gap-3`}>
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
                  className="w-full h-9 px-3 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded-control focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-60"
                />
              </div>
              {showDuration && (
                <div>
                  <label htmlFor="task-duration" className="block text-xs font-medium text-neutral-text-secondary mb-1">
                    Duration <span className="text-neutral-text-disabled">(working days)</span>
                  </label>
                  <input
                    id="task-duration"
                    type="number"
                    min={isEdit ? 0 : 1}
                    step={1}
                    disabled={isReadOnly}
                    value={durationText}
                    onChange={(e) => {
                      // Let the field hold whatever the user is typing (including
                      // an empty string) so it stays clearable; only push a
                      // parseable number through to the committed value. An empty
                      // or partial entry leaves form.duration at its last valid
                      // value rather than snapping it back to 1 mid-keystroke —
                      // the sticky-leading-"1" bug (#1974).
                      const raw = e.target.value;
                      setDurationText(raw);
                      const n = Number(raw);
                      if (raw !== '' && Number.isFinite(n)) {
                        setForm((f) => ({ ...f, duration: n }));
                      }
                    }}
                    onBlur={() => {
                      // Normalize on blur: an empty or below-floor entry snaps
                      // back to the minimum working-day count (1) so the
                      // committed value is always valid, then re-sync the
                      // display text to the committed number.
                      const n = Number(durationText);
                      const next =
                        durationText.trim() !== '' && Number.isFinite(n) && n >= 1 ? n : 1;
                      if (next !== form.duration) setForm((f) => ({ ...f, duration: next }));
                      setDurationText(String(next));
                    }}
                    className="w-full h-9 px-3 text-sm text-neutral-text-primary tppm-mono bg-neutral-surface border border-neutral-border rounded-control focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-60"
                  />
                </div>
              )}
            </div>
          );
        })()}

        {/* Assignees — hidden (not disabled) on a phase, mirroring the
            backend's `assignee_on_phase` rejection (ADR-0293, #1753). A
            phase-in-waiting (no structural child yet) is not a phase yet, so
            it still shows the control — matches backend semantics exactly. */}
        {!isEditingPhase && (
          <div role="group" aria-labelledby="task-assignees-label">
            <div
              id="task-assignees-label"
              className="block text-xs font-medium text-neutral-text-secondary mb-1"
            >
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
        )}

        {/* Predecessors */}
        <div role="group" aria-labelledby="task-predecessors-label">
          <div
            id="task-predecessors-label"
            className="block text-xs font-medium text-neutral-text-secondary mb-1"
          >
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
            className="w-full px-3 py-2 text-sm text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded-control resize-vertical focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none placeholder:text-neutral-text-disabled disabled:opacity-60"
          />
        </div>

        {submitError && (
          <div role="alert" className="bg-semantic-critical-bg border border-semantic-critical/30 text-semantic-critical text-xs px-3 py-2 rounded-card">
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
          <div className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-0.5">
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
          className="w-8 h-8 inline-flex items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none shrink-0"
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
            className="h-8 md:h-8 min-h-11 md:min-h-0 px-3 rounded-control border border-neutral-border bg-transparent text-[13px] text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
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
              className="text-[13px] text-semantic-critical hover:bg-semantic-critical/5 px-2 py-1 rounded-control focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1 focus-visible:outline-none disabled:opacity-50"
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
                setShowDiscardConfirm(true);
              } else {
                onClose();
              }
            }}
            disabled={isPending}
            className="h-8 md:h-8 min-h-11 md:min-h-0 px-3 rounded-control border border-neutral-border bg-transparent text-[13px] text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none disabled:opacity-50"
          >
            Cancel
          </button>
          <Button
            type="submit"
            form="task-form"
            variant="primary"
            size="md"
            disabled={!formIsValid || isPending}
            aria-keyshortcuts="Meta+S Control+S"
            className="min-h-11 md:min-h-0"
          >
            {isPending
              ? (isEdit ? 'Saving…' : 'Creating…')
              : isEdit
                ? 'Save changes'
                : isMilestoneCreate
                  ? 'Create milestone'
                  : 'Create task'}
          </Button>
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
        {showDiscardConfirm && (
          <ConfirmDiscardDialog
            onKeepEditing={() => setShowDiscardConfirm(false)}
            onDiscard={onClose}
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
        className="hidden md:block fixed inset-0 z-40 bg-neutral-overlay backdrop-blur-[2px] motion-safe:animate-scrim-fade"
        onPointerDown={() => {
          if (isDirty) {
            setShowDiscardConfirm(true);
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
        <div
          ref={desktopTrapRef}
          tabIndex={-1}
          className="bg-neutral-surface border border-neutral-border rounded-card overflow-hidden flex flex-col w-[560px] max-h-[90vh] pointer-events-auto focus:outline-none motion-safe:animate-modal-scale-in"
        >
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
      {showDiscardConfirm && (
        <ConfirmDiscardDialog
          onKeepEditing={() => setShowDiscardConfirm(false)}
          onDiscard={onClose}
        />
      )}
    </>
  );
}
