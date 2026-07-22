import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import type { Task } from '@/types';
import {
  registry,
  type DrawerSectionRegistration,
  type DrawerSectionTab,
} from '@/lib/widget-registry';
import { useNavigate } from 'react-router';
import {
  DialogFooter,
  UnsavedChangesDialog,
  useDirtyDraft,
  useUnsavedChangesGuard,
} from '@/components/dialog';
import { TaskDraftProvider, type TaskDraftBinding } from './TaskDraftContext';
import { ComposerDirtyProvider } from './ComposerDirtyContext';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { canEditTask } from '@/lib/roles';
import { Button } from '@/components/Button';
import { ReadinessChip } from '../board/ReadinessChip';
import { CollapsibleSection } from './sections/CollapsibleSection';
import { SectionErrorBoundary } from './sections/SectionErrorBoundary';
import { TaskScheduleStrip } from './TaskScheduleStrip';
import { TaskDescriptionField } from './TaskDescriptionField';
import { registerOssDrawerSections } from './sections';

// Register OSS sections at module init — Enterprise registers in its own
// init module. Both must run before the first drawer render; both are
// idempotent so the order doesn't matter.
registerOssDrawerSections();

/** Fixed tab order for the redesigned drawer (#962). */
const TAB_DEFS: ReadonlyArray<{ id: DrawerSectionTab; label: string }> = [
  { id: 'details', label: 'Details' },
  { id: 'subtasks', label: 'Subtasks' },
  { id: 'activity', label: 'Activity' },
  { id: 'files', label: 'Files' },
];

/**
 * The task's own scalar columns that batch behind the Save/Cancel bar (#1977).
 * Everything else — status, progress, assignees, labels, and every registry
 * section (estimates, dependencies, sprint, …) — mutates immediately through
 * its own endpoint (the web-rule 217 carve-out for instant-toggle / relational
 * controls), so only these two live in the deferred draft.
 */
interface ScalarDraft {
  name: string;
  notes: string;
  // Three-point (PERT) estimate columns, staged as strings (the `<input
  // type="number">` empty state is '' → null on save) and bound into
  // EstimatesTab via TaskDraftContext (#1985).
  optimistic: string;
  mostLikely: string;
  pessimistic: string;
}

const EMPTY_DRAFT: ScalarDraft = {
  name: '',
  notes: '',
  optimistic: '',
  mostLikely: '',
  pessimistic: '',
};

const numOrEmpty = (v: number | null | undefined): string => (v != null ? String(v) : '');

function toDraft(task: Task): ScalarDraft {
  return {
    name: task.name,
    notes: task.notes ?? '',
    optimistic: numOrEmpty(task.optimisticDuration),
    mostLikely: numOrEmpty(task.mostLikelyDuration),
    pessimistic: numOrEmpty(task.pessimisticDuration),
  };
}

/** Parse a staged estimate string to a number, or null for empty/non-finite. */
function parseEstimate(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * The changed keys of the batched PATCH, diffing draft against baseline. Shared
 * by handleSave, saveAndOpen (Save & open), and Cmd/Ctrl+S so all three persist
 * the SAME set — the #1985 estimate keys can't be dropped on one path.
 */
function buildScalarPatch(
  draft: ScalarDraft,
  baseline: ScalarDraft,
): {
  name?: string;
  notes?: string;
  optimistic_duration?: number | null;
  most_likely_duration?: number | null;
  pessimistic_duration?: number | null;
} {
  const patch: ReturnType<typeof buildScalarPatch> = {};
  if (draft.name !== baseline.name) patch.name = draft.name;
  if (draft.notes !== baseline.notes) patch.notes = draft.notes;
  if (draft.optimistic !== baseline.optimistic)
    patch.optimistic_duration = parseEstimate(draft.optimistic);
  if (draft.mostLikely !== baseline.mostLikely)
    patch.most_likely_duration = parseEstimate(draft.mostLikely);
  if (draft.pessimistic !== baseline.pessimistic)
    patch.pessimistic_duration = parseEstimate(draft.pessimistic);
  return patch;
}

/** Join conflicting-field labels into a readable subject, e.g. "Name",
 *  "Name and Estimates", "Name, Description and Estimates" (#2172). */
function formatConflictLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** True when the staged estimate triple is complete AND out of order — the
 *  server 400s this (#1982), so Save is gated on it. A partial triple is fine. */
function estimateTripleInvalid(draft: ScalarDraft): boolean {
  const o = parseEstimate(draft.optimistic);
  const m = parseEstimate(draft.mostLikely);
  const p = parseEstimate(draft.pessimistic);
  return o != null && m != null && p != null && !(o <= m && m <= p);
}

export interface TaskDetailDrawerProps {
  task: Task | null;
  projectId: string;
  onClose: () => void;
  /**
   * Optional context passed to each section's `canRender(ctx)` predicate.
   * Sections use this to hide entirely when a feature is not licensed/available;
   * pass the current user object so Enterprise sections can gate visibility.
   */
  sectionContext?: { user?: unknown };
  /**
   * Optional best-effort focus-restore target on close (#1978, web-rule 264d).
   * The drawer's triggering element is ephemeral on most hosts (a canvas-drawn
   * Gantt bar has no DOM node; a Board popover / ⌘K palette unmounts before the
   * drawer opens), so on close the drawer walks a ladder: the captured opener if
   * it's still connected → this host target → the host container → never
   * `<body>`. A host returns the most precise still-connected node it has (Board:
   * the task's card; Schedule: the focusable canvas viewport; ⌘K: `<main>`).
   */
  getRestoreTarget?: (taskId: string) => HTMLElement | null;
  /**
   * Called when a swap-while-dirty is canceled via "Keep editing" (#1978). The
   * host already moved its selection to the clicked task before the drawer saw
   * the swap, so the drawer keeps rendering the current task and asks the host to
   * restore the prior selection highlight. No-op safe for hosts with no
   * persistent selection highlight (Schedule/Board pass it; ⌘K needn't).
   */
  onSwapCanceled?: (keptTaskId: string) => void;
}

/**
 * Right-side slide-in drawer hosting registry-driven sections grouped into four
 * tabs — Details / Subtasks / Activity / Files (#962, "Direction B").
 *
 * The tab is a presentation grouping layered on top of the ADR-0050 priority
 * ladder: sections still register against `task_detail.section` with a
 * priority and a `tab` (defaulting to `details` for backward compatibility, so
 * Enterprise-registered sections keep rendering). Within a tab the first
 * section is expanded and the rest start collapsed, preserving ADR-0050's
 * lazy-load (a section's TanStack Query hooks fire only when its tab is active
 * and it is expanded).
 *
 * Edit model (#1977): the task's own scalar columns — name and description —
 * batch behind an explicit Save/Cancel bar built on the shared `@/components/
 * dialog` primitives (`useDirtyDraft` + `useUnsavedChangesGuard` + `DialogFooter`
 * + `UnsavedChangesDialog`), the same contract StoryDetailDrawer uses (web-rule
 * 217). There is no auto-flush: Esc / close / expand while dirty raise the
 * unsaved-changes guard instead of silently saving, and switching tabs keeps the
 * draft intact. Everything else — status, progress, assignees, labels, and every
 * registry section — keeps its immediate mutation (the rule-217 carve-out), so
 * only name/description can ever raise the bar.
 *
 * Container (#1978, web-rule 264): the desktop shell is a TRUE non-modal
 * inspector — `aria-modal="false"`, no Tab focus-trap, no scrim — so the
 * Gantt/Board behind it stays live and clickable and clicking another bar/card
 * swaps the drawer's task (parity with the backlog/risk drawers, rules
 * 89/164/185). Mobile stays a modal 85vh bottom sheet (`aria-modal="true"` +
 * focus-trap). A swap or close while the name/notes draft is dirty raises the
 * shared unsaved-changes guard rather than silently clobbering the draft; focus
 * moves in on open and restores best-effort to the host trigger on close.
 *
 * Desktop ≥ md: 540px slide-in. Mobile < md: 85vh bottom sheet.
 */
export function TaskDetailDrawer({
  task: taskProp,
  projectId,
  onClose,
  sectionContext,
  getRestoreTarget,
  onSwapCanceled,
}: TaskDetailDrawerProps) {
  const isMobile = useBreakpoint() === 'sm';

  // The task actually rendered. Normally tracks the `task` prop, but during a
  // swap-while-dirty it deliberately LAGS the prop: the host has already moved
  // its selection to the clicked task, yet the drawer keeps showing the current
  // task (with its unsaved draft) until the swap guard resolves (#1978).
  const [renderedTask, setRenderedTask] = useState<Task | null>(taskProp);
  const task = renderedTask;

  const isOpen = task !== null;
  const drawerTitle = task ? `${task.wbs ? task.wbs + ' — ' : ''}${task.name}` : '';

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // Captured on open for the focus-restore ladder on close (web-rule 264d).
  const openerRef = useRef<HTMLElement | null>(null);

  const { tasks: allTasks } = useScheduleTasks();
  const { mutate: updateTask, isPending: isSaving, isError: saveFailed } = useUpdateTask();
  // 1046: thread the viewer's project role into the sections so write controls
  // (add link, add attachment, edit description) are hidden from Viewers instead
  // of surfacing affordances that 403 on submit. `role` is null while it loads.
  const { role: userRole } = useCurrentUserRole(projectId);
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<DrawerSectionTab>('details');

  // Deferred scalar form (name + description + the three-point estimate) on the
  // shared editable-surface contract (web-rule 217). draft/baseline/dirty +
  // revert + post-save re-snapshot come from the hook; these columns batch
  // behind Save. Estimates reach EstimatesTab via TaskDraftContext (#1985).
  const { draft, setField, baseline, dirty, reset, commit, commitField } =
    useDirtyDraft<ScalarDraft>(task ? toDraft(task) : EMPTY_DRAFT);

  // Swap-while-dirty latch (#1978): when the host points the drawer at a
  // different task while the draft is dirty, park the incoming task here and
  // raise the swap guard instead of reseeding (which would silently clobber the
  // draft — the latent bug this feature exposes).
  const [pendingTask, setPendingTask] = useState<Task | null>(null);
  const [swapGuardOpen, setSwapGuardOpen] = useState(false);

  // Unstaged free-text in a composer (comment / reply / decision-log note) is
  // invisible to the scalar draft, so before #2153 an Escape or a task-swap
  // destroyed it silently. Composers report their text via ComposerDirtyContext;
  // this feeds the dismiss/swap decision below (`guardDirty`) but NOT the Save
  // bar, which only ever persists the scalar fields.
  const [composerDirty, setComposerDirty] = useState(false);

  // Deleted-out-from-under-a-dirty-draft latch (#2054). A WebSocket
  // `task_deleted` drops the task from the cache, so the host's `task` prop goes
  // null while the user has half-written edits. Rather than blink the drawer
  // away and discard them (the swap path is elaborately guarded; the delete path
  // was not), we keep the current task + its draft on screen and raise a warning
  // banner offering "Copy my text".
  const [deletedExternally, setDeletedExternally] = useState(false);

  const taskId = task?.id;

  // The dismiss/swap guard fires on either an unsaved scalar draft OR unstaged
  // composer text — both are destroyed by a silent close or reseed (#2153).
  // Kept separate from the scalar `dirty` used by the Save bar / estimate gating.
  const guardDirty = dirty || composerDirty;

  // Read the latest guard-dirty flag from the identity effect without making it a
  // dependency (that would re-run the identity logic on every keystroke).
  const guardDirtyRef = useRef(guardDirty);
  guardDirtyRef.current = guardDirty;
  // Same trick for the task list: the prop→null branch needs the *current* task
  // set to decide "was this a deliberate deselect (task still exists) or a
  // delete out from under me (task gone)?" without re-running on every fetch.
  const allTasksRef = useRef(allTasks);
  allTasksRef.current = allTasks;

  // Reconcile the `task` prop into the rendered task on an IDENTITY change
  // (open / close / swap). A clean swap (or open) adopts the incoming task and
  // reseeds the draft immediately — the fast cross-reference path. A dirty swap
  // parks the incoming task and raises the guard, keeping the current task and
  // its draft on screen. A prop→null (host close) drops everything. A server
  // update to the SAME task never reseeds (identity unchanged) — the concurrent-
  // edit banner surfaces it instead of clobbering the draft.
  const propId = taskProp?.id ?? null;
  useEffect(() => {
    const currentId = renderedTask?.id ?? null;
    if (propId === currentId) return; // same identity — freshness handled below
    if (taskProp === null) {
      // A deliberate close (X / Esc / backdrop) runs the unsaved-changes guard
      // first, which `reset()`s the draft before `onClose` clears the host
      // selection — so a `taskProp→null` while `dirty` is still true can only
      // mean the task was deleted out from under us (#2054). Confirm it's really
      // gone from the cache (not merely deselected while somehow dirty) before
      // hijacking the close: keep the task + draft on screen and raise the
      // banner instead of discarding half-written edits.
      const prev = renderedTask;
      const currentTasks = allTasksRef.current ?? [];
      const deleted =
        prev !== null &&
        guardDirtyRef.current &&
        currentTasks.length > 0 &&
        !currentTasks.some((t) => t.id === prev.id);
      if (deleted) {
        setDeletedExternally(true);
        return;
      }
      setRenderedTask(null);
      setPendingTask(null);
      setSwapGuardOpen(false);
      setDeletedExternally(false);
      return;
    }
    if (renderedTask === null || !guardDirtyRef.current) {
      setRenderedTask(taskProp);
      commit(toDraft(taskProp));
      setActiveTab('details');
      setDeletedExternally(false);
      return;
    }
    setPendingTask(taskProp);
    setSwapGuardOpen(true);
    // Identity-triggered only; `commit` is stable, dirty is read via ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propId]);

  // Keep the rendered task object fresh while its identity is unchanged, so a
  // server/WebSocket update to the same task (e.g. the concurrent-edit banner's
  // live notes) flows through without reseeding the draft.
  useEffect(() => {
    if (taskProp && renderedTask && taskProp.id === renderedTask.id && taskProp !== renderedTask) {
      setRenderedTask(taskProp);
    }
  }, [taskProp, renderedTask]);

  // Concurrent-edit signal across ALL five staged fields (#2172). For a given
  // staged column, "changed elsewhere" means the live server value drifted from
  // the baseline we opened/last-saved from AND from what the user has typed —
  // someone else saved that field while this draft was open. Previously only
  // `notes` was watched, so a concurrent name/estimate change showed nothing and
  // was silently overwritten on the 409-Reload-retry path. The name of each
  // conflicting field is surfaced in the save bar so the user can reopen before
  // clobbering; the three estimate columns collapse to one "Estimates" token.
  const liveDraft = task ? toDraft(task) : EMPTY_DRAFT;
  const fieldChangedElsewhere = (field: keyof ScalarDraft): boolean =>
    task !== null && dirty && liveDraft[field] !== baseline[field] && liveDraft[field] !== draft[field];
  const notesChangedElsewhere = fieldChangedElsewhere('notes');
  const conflictLabels = [
    fieldChangedElsewhere('name') ? 'Name' : null,
    notesChangedElsewhere ? 'Description' : null,
    fieldChangedElsewhere('optimistic') ||
    fieldChangedElsewhere('mostLikely') ||
    fieldChangedElsewhere('pessimistic')
      ? 'Estimates'
      : null,
  ].filter(Boolean) as string[];

  // An out-of-order complete estimate triple would 400 server-side (#1982), so
  // Save is gated on it everywhere (bar button, Cmd+S, Save & open).
  const estimateInvalid = estimateTripleInvalid(draft);

  const changedEstimates =
    draft.optimistic !== baseline.optimistic ||
    draft.mostLikely !== baseline.mostLikely ||
    draft.pessimistic !== baseline.pessimistic;

  // The estimate slice of the draft, handed to EstimatesTab via context (#1985).
  // A section binds only when `taskId` matches its own task (the swap latch keeps
  // renderedTask ahead of the host selection during a dirty swap).
  const estimateBinding = useMemo<TaskDraftBinding | null>(() => {
    if (!task) return null;
    return {
      taskId: task.id,
      values: {
        optimistic: draft.optimistic,
        mostLikely: draft.mostLikely,
        pessimistic: draft.pessimistic,
      },
      changed: {
        optimistic: draft.optimistic !== baseline.optimistic,
        mostLikely: draft.mostLikely !== baseline.mostLikely,
        pessimistic: draft.pessimistic !== baseline.pessimistic,
      },
      setField: (k, v) => setField(k, v),
      commitField: (k, v) => commitField(k, v),
    };
  }, [
    task,
    draft.optimistic,
    draft.mostLikely,
    draft.pessimistic,
    baseline.optimistic,
    baseline.mostLikely,
    baseline.pessimistic,
    setField,
    commitField,
  ]);

  // Save = one PATCH carrying only the changed scalar keys (name/notes + the
  // #1985 estimate columns), then re-snapshot the baseline on success so the bar
  // clears without waiting on a refetch. `baseVersion` opts this drawer save into
  // ADR-0217 field-level merge so a concurrent overlapping edit 409s (surfacing
  // the conflict toast via useUpdateTask.onError) instead of silently last-writer-
  // wins — matching the board TaskFormModal (#2038).
  const handleSave = useCallback(() => {
    if (!task || estimateInvalid) return;
    const patch = buildScalarPatch(draft, baseline);
    if (Object.keys(patch).length === 0) return;
    updateTask(
      { id: task.id, projectId, baseVersion: task.serverVersion, ...patch },
      { onSuccess: () => commit() },
    );
  }, [task, estimateInvalid, projectId, draft, baseline, updateTask, commit]);

  // Expand → full-page focus view (ADR-0124). A dirty draft is guarded on its
  // own path so Discard navigates to a fresh editable load (Keep editing stays).
  // Declared before the close guard so its Escape listener can stand down while
  // this guard is up (see escapeToClose below).
  const [expandGuardOpen, setExpandGuardOpen] = useState(false);

  // Close / Esc: prompt the unsaved-changes guard when dirty, else close. Revert
  // the draft on close so reopening the same task (identity unchanged → no
  // reseed) never flashes a stale dirty draft. Suspend the guard's document
  // Escape listener while the expand guard is showing — otherwise Esc there
  // would also fire requestClose and silently swap the expand prompt (whose
  // Discard navigates) for the close prompt (whose Discard just closes).
  // Focus-restore ladder (web-rule 264d): the captured opener if still usable →
  // the host-provided target → the app `<main>` region → never `<body>`. Mobile
  // is handled by the bottom-sheet focus-trap's own restore, so this is a
  // desktop-only no-op ladder there.
  const restoreFocus = useCallback(() => {
    if (isMobile) return;
    const usable = (el: HTMLElement | null): el is HTMLElement =>
      !!el && el.isConnected && el.offsetParent !== null;
    const opener = openerRef.current;
    if (usable(opener)) {
      opener.focus();
      return;
    }
    const hostTarget = taskId ? (getRestoreTarget?.(taskId) ?? null) : null;
    if (usable(hostTarget)) {
      hostTarget.focus();
      return;
    }
    const main = document.querySelector('main');
    if (main instanceof HTMLElement) {
      if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
      main.focus();
    }
  }, [isMobile, taskId, getRestoreTarget]);

  const closeAndReset = useCallback(() => {
    restoreFocus();
    reset();
    onClose();
  }, [restoreFocus, reset, onClose]);
  const { requestClose, guardOpen, keepEditing, discard } = useUnsavedChangesGuard({
    dirty: guardDirty,
    onClose: closeAndReset,
    escapeToClose: isOpen && !expandGuardOpen && !swapGuardOpen,
  });

  // Deleted-externally banner verbs (#2054). "Copy my text" lets the user
  // rescue their unsaved draft to the clipboard before dismissing (the task is
  // gone server-side, so there is nothing left to save into); Dismiss tears the
  // now-orphaned drawer down via the normal close path (reset + focus restore).
  const [copiedDraft, setCopiedDraft] = useState(false);
  const handleCopyDeletedDraft = useCallback(() => {
    const parts = [`Task: ${draft.name || 'Untitled task'}`];
    if (draft.notes.trim()) parts.push('', 'Notes:', draft.notes);
    const estimates = [
      draft.optimistic.trim() && `Optimistic: ${draft.optimistic}`,
      draft.mostLikely.trim() && `Most likely: ${draft.mostLikely}`,
      draft.pessimistic.trim() && `Pessimistic: ${draft.pessimistic}`,
    ].filter((line): line is string => Boolean(line));
    if (estimates.length) parts.push('', 'Estimates:', ...estimates);
    void navigator.clipboard?.writeText(parts.join('\n')).then(
      () => {
        setCopiedDraft(true);
        setTimeout(() => setCopiedDraft(false), 2000);
      },
      () => {
        /* Clipboard blocked (permissions/insecure origin) — the text is still on
           screen for a manual copy; swallow rather than crash the banner. */
      },
    );
  }, [draft.name, draft.notes, draft.optimistic, draft.mostLikely, draft.pessimistic]);
  const handleDismissDeleted = useCallback(() => {
    setDeletedExternally(false);
    closeAndReset();
  }, [closeAndReset]);

  const doExpand = useCallback(() => {
    if (!task) return;
    reset();
    onClose();
    void navigate(`/projects/${projectId}/tasks/${task.id}`);
  }, [task, projectId, reset, onClose, navigate]);
  const handleExpand = useCallback(() => {
    // Expanding to the full page unmounts the drawer (and its composers), so an
    // unstaged comment/note is lost the same way a swap loses it — guard on the
    // combined dirty, not just the scalar draft (#2153).
    if (guardDirty) setExpandGuardOpen(true);
    else doExpand();
  }, [guardDirty, doExpand]);

  // Tab-switch keeps the dirty draft intact — the bar docks below the tabpanel,
  // so nothing is lost or silently saved when moving between tabs.
  const changeTab = useCallback((next: DrawerSectionTab) => {
    setActiveTab(next);
  }, []);

  // Swap-while-dirty guard verbs (#1978, web-rule 264c). All three resolve the
  // pending swap: Keep editing stays on the current task (and asks the host to
  // restore its selection highlight, which already moved to the clicked task);
  // Discard & open drops the draft and adopts the pending task; Save & open
  // persists the current task then adopts the pending one (staying on the dialog
  // with an inline error if the save fails — never dropping the pending task).
  const reseedTo = useCallback(
    (next: Task) => {
      setRenderedTask(next);
      commit(toDraft(next));
      setActiveTab('details');
      setPendingTask(null);
      setSwapGuardOpen(false);
      setDeletedExternally(false);
    },
    [commit],
  );
  const keepSwapEditing = useCallback(() => {
    // Ignore a cancel (Escape) while a "Save & open" is in flight: the buttons
    // and backdrop are already disabled, but Escape isn't — and canceling now
    // would race the pending onSuccess, which would still reseed to the task the
    // user just abandoned and desync the host selection (ux-review, #1978).
    if (isSaving) return;
    setSwapGuardOpen(false);
    setPendingTask(null);
    if (renderedTask) onSwapCanceled?.(renderedTask.id);
  }, [isSaving, renderedTask, onSwapCanceled]);
  const discardAndOpen = useCallback(() => {
    if (!pendingTask) return;
    reset();
    reseedTo(pendingTask);
  }, [pendingTask, reset, reseedTo]);
  const saveAndOpen = useCallback(() => {
    // An out-of-order estimate would 400 — keep the guard open (no-op) so the
    // user returns to the drawer and the validation message; never drop the
    // pending task.
    if (!renderedTask || !pendingTask || estimateInvalid) return;
    const patch = buildScalarPatch(draft, baseline);
    const next = pendingTask;
    if (Object.keys(patch).length === 0) {
      reseedTo(next);
      return;
    }
    // baseVersion → ADR-0217 field-merge/409 on the save-and-swap path too (#2038).
    updateTask(
      { id: renderedTask.id, projectId, baseVersion: renderedTask.serverVersion, ...patch },
      { onSuccess: () => reseedTo(next) },
    );
  }, [
    renderedTask,
    pendingTask,
    estimateInvalid,
    draft,
    baseline,
    projectId,
    updateTask,
    reseedTo,
  ]);

  // Cmd/Ctrl+S saves when dirty (matches the settings shell). Only intercept the
  // browser "save page" shortcut when there is actually something to save.
  useEffect(() => {
    if (!isOpen) return undefined;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        // Nothing to save (clean), or the task was deleted out from under us
        // (#2054) so a PATCH would just 404 — let the browser shortcut through.
        if (!dirty || deletedExternally) return;
        e.preventDefault();
        handleSave();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, dirty, deletedExternally, handleSave]);

  // Capture the element that had focus when the drawer opened, for the close-
  // time focus-restore ladder (web-rule 264d). Declared BEFORE the focus-in
  // effect below so on an open it grabs the real trigger, not the Close button
  // we are about to focus. Desktop only — mobile restore is the trap's job.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      const el = document.activeElement;
      openerRef.current =
        !isMobile && el instanceof HTMLElement && el !== document.body ? el : null;
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, isMobile]);

  // Move focus to Close on open so keyboard users land somewhere sensible.
  // Desktop only: the mobile bottom-sheet focus-trap seats its own initial focus.
  useEffect(() => {
    if (isOpen && !isMobile) {
      const id = setTimeout(() => closeButtonRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [isOpen, isMobile, taskId]);

  // Esc is owned by the unsaved-changes guard (escapeToClose) so a dirty drawer
  // prompts instead of closing — no separate Esc effect here.

  // Focus trap: the desktop drawer is NON-modal (web-rule 264a) — no trap, the
  // Gantt/Board behind stays keyboard-reachable. Only the mobile bottom sheet is
  // modal, so the trap engages solely at the `sm` breakpoint (mirroring
  // StoryDetailDrawer). Suspended while any guard dialog is up so the guard's own
  // trap owns the Tab cycle.
  const mobileTrapRef = useFocusTrap<HTMLDivElement>(
    isMobile && isOpen && !guardOpen && !expandGuardOpen && !swapGuardOpen,
  );

  // Read sections from the registry once per render. The registry sorts by
  // priority on register() so no sort here. Filter by canRender so Enterprise
  // sections that gate on license disappear cleanly.
  const sections = useMemo(() => {
    if (!task) return [];
    // A phase — a summary that groups real WBS work — has at least one structural
    // (non-subtask) child. The Subtasks section gates on this so its tab is hidden
    // on a phase but stays visible on a leaf that already has subtasks (#1750).
    const hasStructuralChildren = (allTasks ?? []).some(
      (t) => t.parentId === task.id && t.isSubtask !== true,
    );
    const ctx = { user: sectionContext?.user, task, hasStructuralChildren };
    return (registry.get('task_detail.section') as DrawerSectionRegistration[]).filter(
      (s) => !s.canRender || s.canRender(ctx),
    );
  }, [task, sectionContext?.user, allTasks]);

  // Group the filtered sections by tab (default `details`), preserving the
  // priority order the registry already sorted them into.
  const sectionsByTab = useMemo(() => {
    const map: Record<DrawerSectionTab, DrawerSectionRegistration[]> = {
      details: [],
      subtasks: [],
      activity: [],
      files: [],
    };
    for (const s of sections) map[s.tab ?? 'details'].push(s);
    return map;
  }, [sections]);

  // Subtask done/total for the Subtasks tab badge — derived from the already
  // loaded schedule cache so it costs no extra fetch (an Activity/Files count
  // would force eager fetching, which ADR-0050's lazy-load deliberately avoids).
  const subtaskStats = useMemo(() => {
    if (!task) return { total: 0, done: 0 };
    const subs = (allTasks ?? []).filter((t) => t.parentId === task.id && t.isSubtask === true);
    return {
      total: subs.length,
      done: subs.filter((t) => t.status === 'COMPLETE').length,
    };
    // Only the task identity matters for which children to count, not every
    // field mutation on the task object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTasks, task?.id]);

  // Hide a non-details tab that has no registered sections (e.g. Subtasks for a
  // milestone — its section's canRender returns false). Details always shows
  // (it carries the schedule strip + description).
  const visibleTabs = TAB_DEFS.filter((t) => t.id === 'details' || sectionsByTab[t.id].length > 0);

  const content = task && (
    // Provide the estimate draft to the registry sections (EstimatesTab opts in
    // via useTaskDraft); a section that ignores it keeps its immediate mutation
    // — the DrawerSectionProps contract is unchanged (#1985, ADR-0439).
    <TaskDraftProvider value={estimateBinding}>
      <ComposerDirtyProvider onDirtyChange={setComposerDirty}>
        <DrawerContent
          task={task}
          projectId={projectId}
          userRole={userRole}
          drawerTitle={drawerTitle}
          closeButtonRef={closeButtonRef}
          onRequestClose={requestClose}
          onExpand={handleExpand}
          tabs={visibleTabs}
          activeTab={activeTab}
          onTabChange={changeTab}
          sectionsByTab={sectionsByTab}
          subtaskStats={subtaskStats}
          draftName={draft.name}
          onNameChange={(v) => setField('name', v)}
          changedName={draft.name !== baseline.name}
          draftNotes={draft.notes}
          onNotesChange={(v) => setField('notes', v)}
          changedNotes={draft.notes !== baseline.notes}
          changedEstimates={changedEstimates}
          estimateInvalid={estimateInvalid}
          notesChangedElsewhere={notesChangedElsewhere}
          conflictLabels={conflictLabels}
          deletedExternally={deletedExternally}
          copiedDraft={copiedDraft}
          onCopyDeletedDraft={handleCopyDeletedDraft}
          onDismissDeleted={handleDismissDeleted}
          dirty={dirty}
          isSaving={isSaving}
          saveFailed={saveFailed}
          onSave={handleSave}
          onCancel={reset}
        />
      </ComposerDirtyProvider>
    </TaskDraftProvider>
  );

  return (
    <>
      {/* Mobile backdrop — requests close (guarded when dirty); desktop has no backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/30 md:hidden z-30"
          aria-hidden="true"
          onClick={requestClose}
        />
      )}

      {/* Desktop: 540px right-side slide-in — a TRUE non-modal inspector
          (web-rule 264a). aria-modal="false" and no focus trap: keyboard focus
          can reach the Gantt/Board behind it, which stays live and clickable
          (clicking another bar/card swaps the drawer's task). No scrim on desktop
          (rule 185). */}
      <div
        role="dialog"
        aria-modal="false"
        aria-label={drawerTitle}
        className={[
          'hidden md:flex fixed inset-y-0 right-0 w-[540px] flex-col',
          'bg-neutral-surface border-l border-neutral-border z-40',
          // v2 fluidity (ADR-0126, rule 185): slide on the brand ease (proto .26s).
          // motion-safe so users (and e2e, #1655) with prefers-reduced-motion get
          // an instant snap instead of a transform that Playwright's stability
          // check races against.
          'motion-safe:transition-transform duration-slow ease-brand',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
      >
        {content}
      </div>

      {/* Mobile: 85vh bottom sheet — stays MODAL (web-rule 264a): aria-modal
          ="true" + the focus trap (mobileTrapRef) + the backdrop above. */}
      <div
        ref={mobileTrapRef}
        role="dialog"
        aria-modal="true"
        aria-label={drawerTitle}
        className={[
          'md:hidden fixed inset-x-0 bottom-0 z-40',
          'rounded-t-card bg-neutral-surface border-t border-neutral-border',
          'h-[85vh] flex flex-col',
          'motion-safe:transition-transform duration-200',
          isOpen ? 'translate-y-0' : 'translate-y-full',
        ].join(' ')}
      >
        <div
          className="w-8 h-1 rounded-full bg-neutral-border mx-auto mt-3 mb-2 shrink-0"
          aria-hidden="true"
        />
        {content}
      </div>

      {/* Unsaved-changes guard — shared prompt (web-rule 217). One instance for
          the close/Esc/backdrop path, a second for expand so Discard navigates
          to the full page rather than merely closing. */}
      {guardOpen && <UnsavedChangesDialog onKeepEditing={keepEditing} onDiscard={discard} />}
      {expandGuardOpen && (
        <UnsavedChangesDialog
          onKeepEditing={() => setExpandGuardOpen(false)}
          onDiscard={() => {
            setExpandGuardOpen(false);
            doExpand();
          }}
        />
      )}
      {/* Swap-while-dirty guard (#1978, web-rule 264c) — three verbs, all of
          which resolve the pending swap: Keep editing (Esc) · Discard & open ·
          Save & open (primary, autofocus). Fires only on a dirty swap; clean
          swaps reseed instantly with no dialog. */}
      {swapGuardOpen && renderedTask && pendingTask && (
        <UnsavedChangesDialog
          title="Unsaved changes"
          body={`You have unsaved edits to “${renderedTask.name}”. Open “${pendingTask.name}” anyway?`}
          onKeepEditing={keepSwapEditing}
          onDiscard={discardAndOpen}
          discardLabel="Discard & open"
          onSaveAndContinue={saveAndOpen}
          saveAndContinueLabel="Save & open"
          saving={isSaving}
          error={saveFailed ? "Couldn't save — try again" : null}
        />
      )}
    </>
  );
}

interface DrawerContentProps {
  task: Task;
  projectId: string;
  userRole?: number | null;
  drawerTitle: string;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onRequestClose: () => void;
  onExpand: () => void;
  tabs: ReadonlyArray<{ id: DrawerSectionTab; label: string }>;
  activeTab: DrawerSectionTab;
  onTabChange: (tab: DrawerSectionTab) => void;
  sectionsByTab: Record<DrawerSectionTab, DrawerSectionRegistration[]>;
  subtaskStats: { total: number; done: number };
  draftName: string;
  onNameChange: (value: string) => void;
  changedName: boolean;
  draftNotes: string;
  onNotesChange: (value: string) => void;
  changedNotes: boolean;
  /** Any of the three-point estimate fields is staged-dirty (#1985). */
  changedEstimates: boolean;
  /** The staged estimate triple is complete but out of order — blocks Save (#1982). */
  estimateInvalid: boolean;
  notesChangedElsewhere: boolean;
  /** Human labels of the staged fields the server changed under the open draft
   *  (#2172) — named in the save bar so a concurrent edit isn't silently
   *  overwritten. Empty when nothing drifted. */
  conflictLabels: string[];
  /** The rendered task was deleted by someone else while the draft was dirty
   * (#2054) — show the rescue banner and suppress the (now-futile) Save bar. */
  deletedExternally: boolean;
  copiedDraft: boolean;
  onCopyDeletedDraft: () => void;
  onDismissDeleted: () => void;
  dirty: boolean;
  isSaving: boolean;
  saveFailed: boolean;
  onSave: () => void;
  onCancel: () => void;
}

/**
 * Header + tab strip + active-tab body + save bar, rendered inside both the
 * desktop slide-in and the mobile bottom-sheet shells.
 */
function DrawerContent({
  task,
  projectId,
  userRole,
  drawerTitle,
  closeButtonRef,
  onRequestClose,
  onExpand,
  tabs,
  activeTab,
  onTabChange,
  sectionsByTab,
  subtaskStats,
  draftName,
  onNameChange,
  changedName,
  draftNotes,
  onNotesChange,
  changedNotes,
  changedEstimates,
  estimateInvalid,
  notesChangedElsewhere,
  conflictLabels,
  deletedExternally,
  copiedDraft,
  onCopyDeletedDraft,
  onDismissDeleted,
  dirty,
  isSaving,
  saveFailed,
  onSave,
  onCancel,
}: DrawerContentProps) {
  // Which staged fields changed — names the bar's scope for sighted users (the
  // per-field • markers) and for AT (the sr-only live region below). The three
  // estimate fields collapse to one "Estimates" token (the per-field • carries
  // the precise locality, #1985).
  const changedLabels = [
    changedName ? 'Name' : null,
    changedNotes ? 'Description' : null,
    changedEstimates ? 'Estimates' : null,
  ].filter(Boolean) as string[];
  const statusText = changedLabels.length
    ? `Unsaved changes: ${changedLabels.join(', ')}`
    : 'Unsaved changes';
  // WAI-ARIA tab pattern (#1022): ArrowLeft/Right move selection+focus across
  // the tablist so a keyboard user reaches a sibling tab without Tab-cycling
  // through the active panel's content. Focus follows selection (automatic
  // activation) since switching tabs is cheap here.
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Last Description textarea scrollTop, kept alive across tab switches (issue
  // 1048). DrawerContent stays mounted while the drawer is open, but the Details
  // panel — and the Description field inside it — unmounts when another tab is
  // active, so the scroll cache has to live one level up from the field. Reset
  // it when the task identity changes so a long scroll doesn't leak to the next
  // task opened in the same drawer.
  const descScrollRef = useRef(0);
  useEffect(() => {
    descScrollRef.current = 0;
  }, [task.id]);

  const handleTabKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const idx = tabs.findIndex((t) => t.id === activeTab);
    if (idx === -1) return;
    const nextIdx =
      e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
    const nextId = tabs[nextIdx].id;
    onTabChange(nextId);
    tabRefs.current[nextId]?.focus();
  };

  // Effective edit/delete capability for this drawer (ADR-0133, 1144). Prefer
  // the server-derived per-task verdict; fall back to the client role rule only
  // when the field is absent (pre-field synced rows / optimistic local creates),
  // so a Viewer never sees a flash of editable controls and Scheduler /
  // Member-on-others-tasks / PO cases the client rule gets wrong are corrected.
  const canEdit = task.canEdit ?? canEditTask(userRole);

  return (
    <>
      {/* Header — chips row, editable name, tab strip */}
      <div className="shrink-0 px-4 pt-3 border-b border-neutral-border bg-neutral-surface">
        <div className="flex items-center gap-2 mb-2">
          {task.wbs && (
            <span className="tppm-mono text-xs font-semibold text-neutral-text-secondary px-1.5 py-0.5 rounded-chip bg-neutral-surface-sunken">
              {task.wbs}
            </span>
          )}
          {task.readiness && <ReadinessChip readiness={task.readiness} />}
          {task.isCritical && (
            <span
              className="text-xs font-semibold text-white bg-semantic-critical px-1.5 py-0.5 rounded-chip"
              title="This task is on the critical path — a delay here delays the project end date"
            >
              CP
            </span>
          )}
          {/* "View only" indicator (ADR-0133, 1143). A muted, neutral read-state
              chip — not a warning — present whenever the drawer is non-editable,
              so the absence of write controls is never ambiguous ("is it a bug or
              am I not allowed?"). The lock glyph is decorative; the accessible
              name carries the full reason. */}
          {!canEdit && (
            <span
              className="inline-flex items-center gap-1 text-xs font-medium text-neutral-text-secondary bg-neutral-surface-sunken px-1.5 py-0.5 rounded-chip"
              title="Viewer access — ask an admin for edit access"
              aria-label="View only — Viewer access, ask an admin for edit access"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                className="shrink-0"
              >
                <rect
                  x="3"
                  y="7"
                  width="10"
                  height="7"
                  rx="1.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M5 7V5a3 3 0 0 1 6 0v2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
              View only
            </span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onExpand}
            aria-label="Expand to full page"
            title="Expand to full page"
            className="w-11 h-11 flex items-center justify-center rounded-control text-neutral-text-secondary
              hover:text-neutral-text-primary hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onRequestClose}
            aria-label="Close task detail"
            className="w-11 h-11 -mr-1.5 flex items-center justify-center rounded-control text-neutral-text-secondary
              hover:text-neutral-text-primary hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            ×
          </button>
        </div>

        {/* Hidden heading keeps the dialog's accessible structure + gives tests
            a stable title node; the visible title is an inline editable input. */}
        <h2 className="sr-only">{drawerTitle}</h2>
        <div className="flex items-baseline gap-1.5 mb-2">
          <input
            aria-label="Task name"
            value={draftName}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            // ADR-0133/1142: the title is read-only for non-editors. A readOnly
            // input renders as plain text (bg-transparent, no border) and drops the
            // edit focus ring + caret so it never invites an edit that would 403.
            readOnly={!canEdit}
            className={[
              'min-w-0 flex-1 bg-transparent border-none outline-none px-0',
              'text-xl font-semibold tracking-tight text-neutral-text-primary rounded-control',
              canEdit
                ? 'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1'
                : 'cursor-default focus:outline-none',
            ].join(' ')}
          />
          {/* Unsaved marker — decorative; the sr-only status region carries the
              accessible "unsaved changes in Name" announcement. */}
          {changedName && (
            <span
              aria-hidden="true"
              title="Unsaved"
              className="shrink-0 text-lg leading-none text-brand-primary"
            >
              •
            </span>
          )}
        </div>

        {/* Tabs — arrow-key handling lives on each focusable tab button rather
            than the tablist (the tablist itself is not a tab stop). */}
        <div role="tablist" aria-label="Task detail sections" className="flex gap-1 -mb-px">
          {tabs.map((tab) => {
            const selected = tab.id === activeTab;
            const showCount = tab.id === 'subtasks' && subtaskStats.total > 0;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[tab.id] = el;
                }}
                type="button"
                role="tab"
                id={`drawer-tab-${tab.id}`}
                aria-controls={`drawer-panel-${tab.id}`}
                aria-selected={selected}
                // Roving tabindex: the tablist is a single Tab stop; ArrowLeft/
                // Right move between tabs (WAI-ARIA tab pattern).
                tabIndex={selected ? 0 : -1}
                onKeyDown={handleTabKeyDown}
                onClick={() => onTabChange(tab.id)}
                className={[
                  'inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:rounded-control',
                  selected
                    ? 'border-brand-primary text-brand-primary font-semibold'
                    : 'border-transparent text-neutral-text-secondary font-medium hover:text-neutral-text-primary',
                ].join(' ')}
              >
                {tab.label}
                {showCount && (
                  <span className="tppm-mono text-xs px-1 rounded-chip bg-neutral-surface-sunken text-neutral-text-secondary">
                    {subtaskStats.done}/{subtaskStats.total}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Deleted-by-someone-else rescue banner (#2054). Raised only when the
          task vanished from the cache while the name/notes/estimate draft was
          dirty — the drawer keeps the draft on screen instead of blinking away,
          and offers to copy the text to the clipboard before the (now orphaned)
          drawer is dismissed. role="alert" so AT announces it immediately. */}
      {deletedExternally && (
        <div
          role="alert"
          className="shrink-0 mx-4 mt-3 rounded-control border border-semantic-warning/40 bg-semantic-warning-bg px-3 py-2.5"
        >
          <p className="text-sm font-medium text-neutral-text-primary">
            This task was deleted by someone else.
          </p>
          <p className="mt-0.5 text-xs text-neutral-text-secondary">
            Your unsaved edits are still shown here but can no longer be saved. Copy your text if
            you need it, then dismiss.
          </p>
          <div className="mt-2 flex gap-2">
            <Button variant="secondary" size="sm" onClick={onCopyDeletedDraft}>
              {copiedDraft ? 'Copied' : 'Copy my text'}
            </Button>
            <Button variant="ghost" size="sm" onClick={onDismissDeleted}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Active-tab body — labelled by the active tab so AT announces the
          panel/tab relationship (#1022). Only the active panel is rendered. */}
      <div
        role="tabpanel"
        id={`drawer-panel-${activeTab}`}
        aria-labelledby={`drawer-tab-${activeTab}`}
        tabIndex={0}
        className="flex-1 min-h-0 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
      >
        {activeTab === 'details' &&
          (() => {
            // The Details tab is a curated layout (#962): the schedule strip,
            // the Overview section's work-state (status/progress/people)
            // rendered inline rather than behind an "Overview" accordion, and
            // the deferred Description. The remaining registered details
            // sections (sprint, dependencies, recurrence, estimates, and any
            // Enterprise sections) render as collapsed accordions below.
            const overview = sectionsByTab.details.find((s) => s.id === 'overview');
            const OverviewComp = overview?.component;
            const rest = sectionsByTab.details.filter((s) => s.id !== 'overview');
            return (
              <div>
                <div className="px-4 py-4 space-y-5">
                  <TaskScheduleStrip task={task} projectId={projectId} canEdit={canEdit} />
                  {OverviewComp && (
                    <SectionErrorBoundary sectionTitle="Overview">
                      <OverviewComp
                        taskId={task.id}
                        projectId={projectId}
                        userRole={userRole}
                        canEdit={canEdit}
                      />
                    </SectionErrorBoundary>
                  )}
                  <TaskDescriptionField
                    value={draftNotes}
                    onChange={onNotesChange}
                    changed={changedNotes}
                    changedElsewhere={notesChangedElsewhere}
                    readOnly={!canEdit}
                    scrollTopRef={descScrollRef}
                  />
                </div>
                <SectionList
                  sections={rest}
                  taskId={task.id}
                  projectId={projectId}
                  userRole={userRole}
                  canEdit={canEdit}
                  firstOpen={false}
                />
              </div>
            );
          })()}

        {activeTab !== 'details' && (
          <SectionList
            sections={sectionsByTab[activeTab]}
            taskId={task.id}
            projectId={projectId}
            userRole={userRole}
            canEdit={canEdit}
          />
        )}
      </div>

      {/* AT announcement of the bar's scope — which staged fields are unsaved.
          A polite live region so it never interrupts the user mid-type. */}
      <div className="sr-only" role="status" aria-live="polite">
        {dirty ? statusText : ''}
      </div>

      {/* Save bar (dirty) or Esc hint (clean) — the shared DialogFooter (web-rule
          217) so the task drawer reads the same as every other editable surface.
          Name/description + the three-point estimate stage here (#1985); the
          immediate controls never raise it. `statusText` names which fields
          changed. An out-of-order estimate triple blocks Save (would 400, #1982). */}
      {dirty && !deletedExternally ? (
        <div className="shrink-0 motion-safe:animate-save-bar-slide">
          {/* Concurrent-edit warning naming which staged fields drifted on the
              server while this draft was open (#2172). role="alert" (assertive)
              because acting on the stale bar overwrites someone else's change —
              distinct from the polite unsaved-scope announcement above. */}
          {conflictLabels.length > 0 && (
            <p
              role="alert"
              className="px-4 py-2 border-t border-semantic-at-risk/40 bg-semantic-at-risk/10 text-xs text-semantic-at-risk"
            >
              {formatConflictLabels(conflictLabels)} changed elsewhere since you started editing —
              saving will overwrite {conflictLabels.length > 1 ? 'those changes' : 'that change'}.
            </p>
          )}
          <DialogFooter
            onSave={onSave}
            onCancel={onCancel}
            saving={isSaving}
            saveDisabled={estimateInvalid}
            validationMessage={
              estimateInvalid
                ? 'Estimates must satisfy Optimistic ≤ Most Likely ≤ Pessimistic'
                : null
            }
            statusText={statusText}
            error={saveFailed ? "Couldn't save — try again" : null}
          />
        </div>
      ) : (
        <div className="px-4 py-2 border-t border-neutral-border bg-neutral-surface-raised text-xs text-neutral-text-secondary shrink-0 hidden md:block">
          <span className="tppm-mono">Esc</span> to close
        </div>
      )}
    </>
  );
}

/**
 * Renders a tab's registered sections in priority order. When `firstOpen` is
 * true the first section is expanded; the rest start collapsed so their queries
 * fire only on expand (ADR-0050 lazy-load, preserved tab-by-tab). The Details
 * tab passes `firstOpen={false}` because its primary content (Overview) is
 * rendered curated above these secondary accordions.
 */
export function SectionList({
  sections,
  taskId,
  projectId,
  userRole,
  canEdit,
  firstOpen = true,
}: {
  sections: DrawerSectionRegistration[];
  taskId: string;
  projectId: string;
  userRole?: number | null;
  /** Effective server-derived edit capability for the task (ADR-0133); threaded
   *  to every section so write controls gate off the authoritative verdict. */
  canEdit?: boolean;
  firstOpen?: boolean;
}) {
  // The 'sprint' section is registered with a static title in the module-level
  // registry (sections/index.ts) which has no project context; resolve the
  // configurable container label here at the render boundary (ADR-0111, #862).
  const itl = useIterationLabel(projectId);
  if (sections.length === 0) {
    return (
      <div className="px-4 py-6 text-sm italic text-neutral-text-secondary">Nothing here yet.</div>
    );
  }
  return (
    <>
      {sections.map((section, idx) => {
        const SectionComponent = section.component;
        const sectionTitle = section.id === 'sprint' ? itl.singular : section.title;
        return (
          <SectionErrorBoundary key={section.id} sectionTitle={sectionTitle}>
            <CollapsibleSection
              id={section.id}
              title={sectionTitle}
              defaultOpen={firstOpen && idx === 0}
            >
              {() => (
                <SectionComponent
                  taskId={taskId}
                  projectId={projectId}
                  userRole={userRole}
                  canEdit={canEdit}
                />
              )}
            </CollapsibleSection>
          </SectionErrorBoundary>
        );
      })}
    </>
  );
}
