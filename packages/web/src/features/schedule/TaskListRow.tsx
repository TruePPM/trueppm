import { memo, useState, useRef, useCallback, useEffect } from 'react';
import type React from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import type { Task } from '@/types';
import { ROW_HEIGHT, WBS_INDENT } from './scheduleConstants';
import { ScopeChangedChip } from '@/features/sprints/ScopeChangedChip';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import { useScheduleStore } from '@/stores/scheduleStore';
import {
  useUpdateTask,
  useReorderTasks,
  parseMilestoneRollupLockedError,
  parseProgressAnchorError,
  parseGuardrailWarnings,
  parseGuardrailBlockedError,
  useToggleComplete,
  useDuplicateTask,
  type GuardrailWarning,
} from '@/hooks/useTaskMutations';
import { GuardrailNotice } from './sections/GuardrailNotice';
import { GuardrailBlock } from './sections/GuardrailBlock';
import { useDragStore } from '@/stores/dragStore';
import { AssigneeChips } from './AssigneeChips';
import {
  useBuildMode,
  EditableCell,
  BuildModeRowMenu,
  NameAutocomplete,
  MilestoneDatePopover,
  SprintPrompt,
  type RowMenuItem,
} from './buildMode';

interface Props {
  task: Task;
  level: number;
  widths: ColumnWidths['widths'];
  visible: ColumnWidths['visible'];
  hasChildren?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
  /** Previous visible task id — null at the top. Drives ArrowUp navigation. */
  prevTaskId?: string | null;
  /** Next visible task id — null at the bottom. Drives ArrowDown navigation. */
  nextTaskId?: string | null;
  /**
   * When focus mode is active and this task is NOT in the focused chain,
   * the row is dimmed to ~22% opacity (spec: focus mode § ④).
   */
  dimmed?: boolean;
  /**
   * Predecessor/successor dep-chip data — shown inline when this task is selected
   * and focus mode is on (spec § ④). Chips appear to the right of the task name.
   */
  depChips?: {
    predsCount: number;
    succsCount: number;
    predsCritical: boolean;
    succsCritical: boolean;
  };
  /**
   * Ordered IDs of all same-wbs-level siblings. Used for Option/Alt+↑/↓ reorder (#347).
   * Includes this task's own id.
   */
  siblingIds?: string[];
  /** Task name suggestions for the inline autocomplete dropdown (#343). */
  nameSuggestions?: string[];
  /** Parent summary tasks (closest ancestor first) — for milestone date quick-picks (#345). */
  milestoneParents?: { name: string; finish?: string }[];
  /**
   * Hover bus callback (#475) — fires when the cursor enters or leaves the row,
   * and when keyboard focus moves on/off. Wires through ScheduleView to
   * `engine.setHoverChain` so the canvas + task list dim non-chain rows.
   */
  onHoverChange?: (taskId: string | null) => void;
  /**
   * Open the dependency picker for this task in the given mode (#477).
   * Lifted to ScheduleView so the modal is a DOM sibling, not embedded in the row.
   */
  onAddDependencyRequest?: (taskId: string, mode: 'predecessor' | 'successor') => void;
  /** Existing sibling names at the row's WBS-parent level — used to suffix "(copy)". */
  siblingNames?: string[];
  /** Source sprint snapshot used by the Undo affordance. Null when not in a sprint. */
  sourceSprint?: { id: string; name: string; state: string } | null;
}

// On macOS the modifier is labelled "Option"; everywhere else it's "Alt".
const REORDER_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Option' : 'Alt';

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Truncate a long WBS path with a middle ellipsis so the leaf number (most
 * relevant) stays visible. "1.10.5.2" with budget 6 → "1.…2".
 * Returns the full path unchanged when it already fits.
 */
export function truncateWbsPath(path: string, maxChars: number): string {
  if (path.length <= maxChars) return path;
  if (maxChars < 3) return '…';
  // Keep first segment + ellipsis + last segment, padded to maxChars budget.
  const parts = path.split('.');
  if (parts.length <= 2) return path.slice(0, maxChars - 1) + '…';
  return `${parts[0]}.…${parts[parts.length - 1]}`;
}

/** Derive WBS parent path for reorder API (ltree format). Root tasks return "". */
function wbsParentPath(wbs: string): string {
  const parts = wbs.split('.');
  return parts.slice(0, -1).join('.');
}

/** Today in local timezone as YYYY-MM-DD (mirrors localDateISO in sprintMath.ts). */
function todayLocalISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Add n calendar days to an ISO date string. */
function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function TaskListRowInner({
  task,
  level,
  widths,
  visible,
  hasChildren = false,
  isExpanded = false,
  onToggle,
  prevTaskId = null,
  nextTaskId = null,
  dimmed = false,
  depChips,
  siblingIds,
  nameSuggestions,
  milestoneParents,
  onHoverChange,
  onAddDependencyRequest,
  siblingNames,
  sourceSprint,
}: Props) {
  const projectId = useProjectId() ?? '';
  const selectedTaskId = useScheduleStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
  const setScheduleError = useScheduleStore((s) => s.setScheduleError);
  const setScheduleActionToast = useScheduleStore((s) => s.setScheduleActionToast);
  const isSelected = selectedTaskId === task.id;
  const updateTask = useUpdateTask();
  const toggleComplete = useToggleComplete();
  const duplicateTask = useDuplicateTask();

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = useCallback(() => {
    setEditValue(task.name);
    setIsEditing(true);
  }, [task.name]);

  // Focus and select when edit mode activates (avoids jsx-a11y/no-autofocus)
  const prevEditingRef = useRef(false);
  if (isEditing && !prevEditingRef.current && inputRef.current) {
    inputRef.current.focus();
    inputRef.current.select();
  }
  prevEditingRef.current = isEditing;

  const commitEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== task.name) {
      updateTask.mutate({ id: task.id, projectId, name: trimmed });
    }
    setIsEditing(false);
  }, [editValue, task.id, task.name, projectId, updateTask]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
  }, []);

  // ──────────────────────────────────────────────────────────────────────
  // Build-mode wiring (issues #338/#339/#341, gated on the flag — null when
  // the BuildModeProvider is not mounted, in which case all flag-off
  // behavior above remains exactly unchanged).
  // ──────────────────────────────────────────────────────────────────────
  const buildMode = useBuildMode();
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);

  // #347: sibling reorder via Option/Alt+↑/↓ and ⋮⋮ handle
  const reorderTasks = useReorderTasks(projectId || null);
  const reorderHandleRef = useRef<{ startY: number } | null>(null);

  // #343: name autocomplete state
  const [autocompleteQuery, setAutocompleteQuery] = useState('');

  // #344: ghost bar store actions (effects wired below, after editingColumnName is declared)
  const startBuilding = useDragStore((s) => s.startBuilding);
  const stopBuilding = useDragStore((s) => s.stopBuilding);

  // #345: milestone date picker visibility
  const [showMilestonePicker, setShowMilestonePicker] = useState(false);

  // #346: sprint prompt visibility
  const [showSprintPrompt, setShowSprintPrompt] = useState(false);

  // #875: outcome state for the post-commit sprint assignment — surfaces a
  // GuardrailNotice (warn, with one-tap override + undo) or GuardrailBlock
  // (Owner-escalated, no override) anchored to the same position as the
  // SprintPrompt so the build-mode user sees the consequence inline without
  // leaving the row. `priorSprintId` lets Undo revert the assignment.
  type SprintOutcome =
    | { kind: 'warn'; warnings: GuardrailWarning[]; priorSprintId: string | null }
    | { kind: 'block'; detail: string };
  const [sprintOutcome, setSprintOutcome] = useState<SprintOutcome | null>(null);

  const isBuildSelected = buildMode?.focus.isRowFocused(task.id) ?? false;
  const editingColumnName = buildMode?.focus.isCellInEdit(task.id, 'name') ?? false;
  const editingColumnDuration = buildMode?.focus.isCellInEdit(task.id, 'duration') ?? false;
  const editingColumnProgress = buildMode?.focus.isCellInEdit(task.id, 'progress') ?? false;
  const anyCellInEdit = editingColumnName || editingColumnDuration || editingColumnProgress;

  // #344: start/stop build ghost bar when name cell enters/exits edit mode
  useEffect(() => {
    if (!buildMode || !editingColumnName) {
      stopBuilding();
      return;
    }
    const today = todayLocalISO();
    const defaultFinish = addDaysISO(today, 4); // 5-day inclusive bar
    startBuilding(task.id, today, defaultFinish);
    return () => {
      stopBuilding();
    };
    // startBuilding/stopBuilding are stable store actions, task.id/buildMode are deps that matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingColumnName, buildMode, task.id]);

  // Move keyboard focus to a sibling row by data-row-id selector. Used by both
  // the build-mode and flag-off arrow-key handlers so the destination row
  // becomes the active element and subsequent arrows continue to traverse.
  const focusRowDom = useCallback((id: string) => {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
      el?.focus();
    });
  }, []);

  const handleBuildKeyDown = (e: React.KeyboardEvent) => {
    if (!buildMode || anyCellInEdit) return;
    // Option/Alt+↑/↓ — reorder among same-indent siblings (#347)
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && siblingIds) {
      e.preventDefault();
      const currentIdx = siblingIds.indexOf(task.id);
      if (currentIdx === -1) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const newIdx = currentIdx + delta;
      if (newIdx < 0 || newIdx >= siblingIds.length) return;
      const newOrder = [...siblingIds];
      newOrder.splice(currentIdx, 1);
      newOrder.splice(newIdx, 0, task.id);
      reorderTasks.mutate({ parent_path: wbsParentPath(task.wbs), ordered_ids: newOrder });
      return;
    }

    // Arrow up/down — move row focus to the previous/next visible row.
    // Documented in useScheduleFocus's docstring; previously unimplemented (#340 follow-up).
    if (!e.altKey && e.key === 'ArrowDown' && nextTaskId) {
      e.preventDefault();
      buildMode.focus.focusRow(nextTaskId);
      focusRowDom(nextTaskId);
      return;
    }
    if (!e.altKey && e.key === 'ArrowUp' && prevTaskId) {
      e.preventDefault();
      buildMode.focus.focusRow(prevTaskId);
      focusRowDom(prevTaskId);
      return;
    }
    // Tab on a focused row → indent (Shift-Tab → outdent). The focus reducer
    // ignores Tab in RowFocused — caller (this) handles the structural action.
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) buildMode.outdent(task.id);
      else buildMode.indent(task.id);
      return;
    }
    // Letter key (single printable, not modified) opens Name cell-edit
    // pre-filled with the typed letter — but we keep it simple in v1 and
    // just enter cell-edit; the user re-types if they want to overwrite.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && /[a-zA-Z0-9]/.test(e.key)) {
      e.preventDefault();
      buildMode.focus.enterCellEdit(task.id, 'name');
      return;
    }
    // Delete (Backspace/Delete) on focused row — destructive, no confirm.
    // Toast-undo is the safety net (see ux-design spec); v1 surfaces a toast
    // via the mutation's onError, not on success — the destructive nature is
    // intentional but reversible by re-creating the task.
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      buildMode.deleteTask(task.id);
      return;
    }
    // Esc clears focus.
    if (e.key === 'Escape') {
      e.preventDefault();
      buildMode.focus.clear();
    }
  };

  // #347: ⋮⋮ drag handle pointer handlers
  const handleReorderPointerDown = (e: React.PointerEvent) => {
    if (!buildMode || !siblingIds) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    reorderHandleRef.current = { startY: e.clientY };
  };

  const handleReorderPointerMove = (e: React.PointerEvent) => {
    if (!reorderHandleRef.current) return;
    e.preventDefault();
  };

  const handleReorderPointerUp = (e: React.PointerEvent) => {
    if (!reorderHandleRef.current || !siblingIds) return;
    const deltaY = e.clientY - reorderHandleRef.current.startY;
    reorderHandleRef.current = null;
    const deltaRows = Math.round(deltaY / ROW_HEIGHT);
    if (deltaRows === 0) return;
    const currentIdx = siblingIds.indexOf(task.id);
    if (currentIdx === -1) return;
    const newIdx = Math.max(0, Math.min(siblingIds.length - 1, currentIdx + deltaRows));
    if (newIdx === currentIdx) return;
    const newOrder = [...siblingIds];
    newOrder.splice(currentIdx, 1);
    newOrder.splice(newIdx, 0, task.id);
    reorderTasks.mutate({ parent_path: wbsParentPath(task.wbs), ordered_ids: newOrder });
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!buildMode) return;
    // #806: suppress right-click while a structural mutation (indent/outdent/
    // delete) is in flight for this row. Opening the menu mid-delete strands
    // the BuildModeRowMenu portal when the row unmounts on cache invalidation,
    // which then blocks subsequent right-clicks on other rows until refresh.
    if (buildMode.isMutationPending(task.id)) return;
    e.preventDefault();
    buildMode.focus.focusRow(task.id);
    setMenuAnchor({ x: e.clientX, y: e.clientY });
  };

  // ──────────────────────────────────────────────────────────────────────
  // Mark complete (#477) — Space toggle on focused row, also from context
  // menu. Optimistic; surfaces progress-anchor 400 toast on rollback.
  // ──────────────────────────────────────────────────────────────────────
  const handleToggleComplete = useCallback(() => {
    if (!projectId || task.isMilestone) return;
    toggleComplete.mutate(
      { id: task.id, projectId, previousStatus: task.status },
      {
        onError: (err) => {
          const anchor = parseProgressAnchorError(err);
          setScheduleError(anchor?.detail ?? 'Failed to update task status.');
          // Auto-clear the error toast after 4 s so it doesn't pin to the
          // bottom of the screen indefinitely (#362 pattern).
          setTimeout(() => setScheduleError(null), 4000);
        },
      },
    );
  }, [projectId, task.id, task.status, task.isMilestone, toggleComplete, setScheduleError]);

  // ──────────────────────────────────────────────────────────────────────
  // Duplicate (#477) — frontend-only via POST /tasks/ with `(copy)` suffix,
  // inheriting parent + sprint. ACTIVE-sprint duplicates surface an Undo
  // toast so the PM can revert with one click (ADR-0066 Q2).
  // ──────────────────────────────────────────────────────────────────────
  const handleDuplicate = useCallback(() => {
    if (!projectId) return;
    duplicateTask.mutate(
      {
        projectId,
        source: {
          name: task.name,
          duration: task.duration,
          parent_id: task.parentId,
          sprint_id: task.sprintId ?? null,
          is_milestone: task.isMilestone,
        },
        siblingNames: siblingNames ?? [],
      },
      {
        onSuccess: (created) => {
          if (sourceSprint && sourceSprint.state === 'ACTIVE') {
            setScheduleActionToast({
              message: `Added to ${sourceSprint.name}`,
              action: {
                label: 'Undo',
                onClick: () => {
                  updateTask.mutate({ id: created.id, projectId, sprint: null });
                  setScheduleActionToast({ message: 'Moved to backlog', durationMs: 2000 });
                },
              },
            });
          }
        },
        onError: () => {
          setScheduleError('Failed to duplicate task.');
          setTimeout(() => setScheduleError(null), 4000);
        },
      },
    );
  }, [
    projectId,
    task.name,
    task.duration,
    task.parentId,
    task.sprintId,
    task.isMilestone,
    siblingNames,
    sourceSprint,
    duplicateTask,
    updateTask,
    setScheduleActionToast,
    setScheduleError,
  ]);

  const isComplete = task.status === 'COMPLETE';
  const menuItems: RowMenuItem[] = buildMode
    ? [
        {
          key: 'edit',
          label: 'Edit',
          icon: '✎',
          hint: 'F2',
          onSelect: () => buildMode.focus.enterCellEdit(task.id, 'name'),
        },
        {
          key: 'toggle-complete',
          // Toggle copy flip — when the task is already COMPLETE the same
          // action un-marks it (ADR-0066 Q3 / ux-design item 2).
          label: isComplete ? 'Unmark complete' : 'Mark complete',
          icon: isComplete ? '↺' : '☑',
          hint: 'Space',
          // Milestones are date points; toggling status on them is meaningless.
          disabled: task.isMilestone,
          onSelect: handleToggleComplete,
        },
        {
          key: 'indent',
          label: 'Indent',
          icon: '⇥',
          hint: 'Tab',
          startsGroup: true,
          disabled: level <= 1,
          onSelect: () => buildMode.indent(task.id),
        },
        {
          key: 'outdent',
          label: 'Outdent',
          icon: '⇤',
          hint: '⇧+Tab',
          // Disable outdent at root level (level 1).
          disabled: level <= 1,
          onSelect: () => buildMode.outdent(task.id),
        },
        {
          key: 'add-predecessor',
          label: 'Add predecessor…',
          icon: '↗',
          startsGroup: true,
          disabled: !onAddDependencyRequest,
          onSelect: () => onAddDependencyRequest?.(task.id, 'predecessor'),
        },
        {
          key: 'add-successor',
          label: 'Add successor…',
          icon: '↙',
          disabled: !onAddDependencyRequest,
          onSelect: () => onAddDependencyRequest?.(task.id, 'successor'),
        },
        {
          key: 'duplicate',
          label: 'Duplicate',
          icon: '⎘',
          hint: '⌘D',
          startsGroup: true,
          onSelect: handleDuplicate,
        },
        {
          key: 'milestone',
          label: 'Convert to milestone',
          icon: '◆',
          disabled: task.isMilestone,
          onSelect: () => buildMode.convertToMilestone(task.id),
        },
        {
          key: 'delete',
          label: 'Delete',
          icon: '🗑',
          hint: '⌫',
          destructive: true,
          startsGroup: true,
          onSelect: () => buildMode.deleteTask(task.id),
        },
      ]
    : [];

  const isCriticalStyle = task.isCritical
    ? 'font-semibold text-semantic-critical'
    : 'text-neutral-text-primary';

  const isSummaryStyle = task.isSummary ? 'font-medium' : '';

  // Data-integrity warning (issue #317): a task that has reached IN_PROGRESS /
  // REVIEW / COMPLETE without a PM-committed `planned_start` is a data error,
  // not "needs scheduling". We check `plannedStart`, not `start`, because CPM
  // auto-fills `early_start` for every task — using `start` would never fire.
  const hasMissingDatesWarning =
    !task.plannedStart &&
    !task.isSummary &&
    (task.status === 'IN_PROGRESS' || task.status === 'REVIEW' || task.status === 'COMPLETE');

  // Width available for task name content: full task column minus indent, chevron, and base left padding.
  // (paddingLeft = (level-1)*WBS_INDENT + 8; chevron = 18px; base = 8px)
  const taskNameWidth = Math.max(0, widths.task - (level - 1) * WBS_INDENT - 26);

  // Pending state during indent/outdent/delete — shows the row in an "in-flight"
  // treatment (per ADR-0054 § Optimistic update strategy: no client prediction,
  // server response is canonical).
  const isStructuralPending = buildMode?.isMutationPending(task.id) ?? false;

  // #806: if the row enters a pending mutation while its context menu is open,
  // close the menu immediately. A delete mutation will unmount this component on
  // cache invalidation; without this close the BuildModeRowMenu portal's
  // menuAnchor lives on in unreachable state and its global Escape/click-outside
  // listeners block subsequent right-clicks on every other row until refresh.
  useEffect(() => {
    if (isStructuralPending) setMenuAnchor(null);
  }, [isStructuralPending]);

  return (
    <div
      role="row"
      data-row-id={task.id}
      aria-selected={buildMode ? isBuildSelected : isSelected}
      tabIndex={isEditing || anyCellInEdit ? -1 : 0}
      style={{ height: ROW_HEIGHT }}
      className={[
        'relative group flex items-stretch text-xs border-b border-neutral-border/20',
        // motion-safe transition so the hover-chain dim/un-dim (#475) doesn't
        // snap when the cursor sweeps across many rows — without this the rapid
        // chain recomputes show as flicker.
        'motion-safe:transition-opacity motion-safe:duration-150 motion-safe:ease-out',
        isEditing || anyCellInEdit ? 'cursor-text' : 'cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary dark:focus-visible:ring-semantic-on-track',
        (buildMode ? isBuildSelected : isSelected) && !(isEditing || anyCellInEdit)
          ? 'bg-brand-primary/10 border-l-2 border-brand-primary'
          : 'hover:bg-white/5',
        dimmed ? 'opacity-[0.22] pointer-events-none' : '',
        isStructuralPending ? 'opacity-70 cursor-progress' : '',
      ].join(' ')}
      onClick={() => {
        if (isEditing || anyCellInEdit) return;
        if (buildMode) {
          buildMode.focus.focusRow(task.id);
        } else {
          setSelectedTaskId(isSelected ? null : task.id);
        }
      }}
      onDoubleClick={() => {
        if (buildMode) {
          // Build-mode double-click → enter Name cell (consistent across all editable cells).
          buildMode.focus.focusRow(task.id);
          buildMode.focus.enterCellEdit(task.id, 'name');
        } else {
          startEdit();
        }
      }}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => onHoverChange?.(task.id)}
      onMouseLeave={() => onHoverChange?.(null)}
      onFocus={() => onHoverChange?.(task.id)}
      onBlur={(e) => {
        // Only clear hover when focus actually leaves the row, not when it
        // moves to a child element (e.g. EditableCell input).
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          onHoverChange?.(null);
        }
      }}
      onKeyDown={(e) => {
        // When the sprint-outcome panel is mounted (warn/block after SprintPrompt
        // committed), any key originating inside it — especially Space typed into
        // the optional reason input, or Esc to dismiss — must not bubble into
        // the row's Mark-Complete / clear-focus shortcuts. ADR-0101 §2: the
        // warn reason field is always optional and never blocked from input.
        if (sprintOutcome && e.target !== e.currentTarget) return;
        // Build-mode owns Tab/Letter/Delete/Esc on the row; let it run first.
        if (buildMode) {
          handleBuildKeyDown(e);
          if (e.defaultPrevented) return;
        }
        if (isEditing || anyCellInEdit) return;
        // Arrow up/down — flag-off path. Build-mode path is handled above.
        if (!buildMode && e.key === 'ArrowDown' && nextTaskId) {
          e.preventDefault();
          setSelectedTaskId(nextTaskId);
          focusRowDom(nextTaskId);
          return;
        }
        if (!buildMode && e.key === 'ArrowUp' && prevTaskId) {
          e.preventDefault();
          setSelectedTaskId(prevTaskId);
          focusRowDom(prevTaskId);
          return;
        }
        // Space rebinds to Mark complete on the focused row (ADR-0066 Q5).
        // Today both Enter and Space were redundant ("open drawer"); Enter
        // keeps that meaning, Space gets the new high-frequency action.
        if (e.key === ' ') {
          e.preventDefault();
          handleToggleComplete();
          return;
        }
        // ⌘D / Ctrl+D — Duplicate the focused row (ADR-0066 Q1). Always
        // preventDefault to suppress the browser bookmark dialog.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
          e.preventDefault();
          handleDuplicate();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (buildMode) {
            // Enter on row → enter Name cell-edit (per ux-design spec).
            buildMode.focus.enterCellEdit(task.id, 'name');
          } else {
            setSelectedTaskId(isSelected ? null : task.id);
          }
        }
        if (e.key === 'F2') {
          e.preventDefault();
          if (buildMode) {
            buildMode.focus.enterCellEdit(task.id, 'name');
          } else {
            startEdit();
          }
        }
      }}
    >
      {/* ── ⋮⋮ reorder handle — build mode only, visible on row hover (#347) ── */}
      {buildMode && siblingIds && (
        <div
          className="absolute left-0 inset-y-0 w-3.5 flex items-center justify-center z-10
            opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing
            text-neutral-text-disabled hover:text-neutral-text-secondary"
          title={`Drag to reorder  ·  ${REORDER_KEY}+↑/↓ keyboard`}
          aria-hidden="true"
          onPointerDown={handleReorderPointerDown}
          onPointerMove={handleReorderPointerMove}
          onPointerUp={handleReorderPointerUp}
        >
          <svg width="7" height="11" viewBox="0 0 7 11" fill="currentColor" aria-hidden="true">
            <circle cx="1.5" cy="1.5" r="1.2" />
            <circle cx="5.5" cy="1.5" r="1.2" />
            <circle cx="1.5" cy="5.5" r="1.2" />
            <circle cx="5.5" cy="5.5" r="1.2" />
            <circle cx="1.5" cy="9.5" r="1.2" />
            <circle cx="5.5" cy="9.5" r="1.2" />
          </svg>
        </div>
      )}

      {/* ── WBS column (#248) ───────────────────────────────────────────────── */}
      {visible.wbs && (
        <div
          className="flex items-center justify-end shrink-0 border-r border-neutral-border/20
            text-right text-neutral-text-secondary tppm-mono pr-2 text-xs"
          style={{ width: widths.wbs }}
          role="gridcell"
          aria-label={`WBS ${task.wbs}`}
          title={task.wbs}
        >
          {truncateWbsPath(task.wbs, Math.max(3, Math.floor(widths.wbs / 8) - 1))}
        </div>
      )}

      {/* ── Task column ─────────────────────────────────────────────────────── */}
      {/* Positioned wrapper carries the WBS indent. Properties button lives here
          so it never overlaps the Dur·Start or % columns. */}
      <div
        className="relative flex items-center shrink-0 border-r border-neutral-border/20"
        style={{ width: widths.task, paddingLeft: (level - 1) * WBS_INDENT + 8 }}
      >
        {/* Collapse/expand chevron for summary tasks */}
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle?.();
            }}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? `Collapse ${task.name}` : `Expand ${task.name}`}
            className="shrink-0 w-4 h-4 flex items-center justify-center mr-0.5
              text-neutral-text-secondary hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand-primary dark:focus-visible:ring-semantic-on-track rounded"
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              fill="currentColor"
              aria-hidden="true"
              className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
            >
              <path d="M2 1l4 3-4 3z" />
            </svg>
          </button>
        ) : (
          <span className="shrink-0 w-4 mr-0.5" aria-hidden="true" />
        )}

        {/* Milestone diamond indicator */}
        {task.isMilestone && (
          <span className="mr-1 text-brand-accent" aria-hidden="true">
            ◆
          </span>
        )}

        {/* Task name — inline input when editing.
            Build-mode uses the EditableCell primitive (Tab traverses to next
            cell). Flag-off path keeps the existing simple input (legacy behavior). */}
        {buildMode && editingColumnName ? (
          <div className="relative flex-1 min-w-0">
            <EditableCell
              column="name"
              value={task.name}
              isEditing={true}
              inputType="text"
              ariaLabel={`Rename task ${task.name}`}
              className="flex-1 min-w-0 w-full"
              onStartEdit={() => {
                /* already editing */
              }}
              onCommit={(parsed) => {
                if (typeof parsed === 'string' && projectId) {
                  updateTask.mutate({ id: task.id, projectId, name: parsed });
                  setShowSprintPrompt(true);
                }
                setAutocompleteQuery('');
                buildMode.focus.commitToRow();
              }}
              onRollback={() => {
                setAutocompleteQuery('');
                buildMode.focus.rollbackToRow();
              }}
              onTabForward={() => buildMode.focus.tabForward()}
              onTabBackward={() => buildMode.focus.tabBackward()}
              onQueryChange={setAutocompleteQuery}
            />
            {nameSuggestions && (
              <NameAutocomplete
                query={autocompleteQuery}
                suggestions={nameSuggestions}
                onSelect={(name) => {
                  updateTask.mutate({ id: task.id, projectId, name });
                  setAutocompleteQuery('');
                  buildMode.focus.commitToRow();
                }}
                onDismiss={() => setAutocompleteQuery('')}
              />
            )}
          </div>
        ) : isEditing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitEdit();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                cancelEdit();
              }
            }}
            className="flex-1 min-w-0 bg-brand-primary/10 text-neutral-text-primary text-xs px-1 rounded
              outline-none ring-1 ring-brand-primary truncate"
            style={{ height: 20 }}
            aria-label={`Rename task ${task.name}`}
          />
        ) : (
          <div
            className="flex shrink-0 min-w-0 items-center gap-1 overflow-hidden"
            style={{ width: taskNameWidth }}
          >
            <span
              className={`min-w-0 shrink truncate ${isCriticalStyle} ${isSummaryStyle}`}
              title={
                task.isCritical
                  ? 'This task is on the critical path — a delay here delays the project end date'
                  : `${task.name} — double-click to rename`
              }
              aria-label={`${task.wbs} ${task.name}${task.isCritical ? ' (critical path)' : ''}${task.assignees.length > 0 ? ` — assigned to ${task.assignees.map((a) => a.name).join(', ')}` : ''}`}
            >
              {task.name}
            </span>
            {hasMissingDatesWarning && (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 px-1 py-px rounded text-xs font-medium text-semantic-at-risk border border-semantic-at-risk/40"
                title="This task is in progress but has no schedule dates. Set a start date or move it to To Do."
                aria-label="Missing schedule dates"
                data-testid="missing-dates-chip"
              >
                <span aria-hidden="true">⚠</span>
                <span>missing dates</span>
              </span>
            )}
            {/* Dep chips — shown when task is selected in focus mode; replaces assignee chips */}
            {isSelected && depChips ? (
              <span
                className="flex items-center gap-0.5 flex-shrink-0"
                aria-label={`${depChips.predsCount} predecessors, ${depChips.succsCount} successors`}
              >
                {depChips.predsCount > 0 && (
                  <span
                    className={`inline-flex items-center px-1 py-px rounded text-xs font-medium cursor-pointer ${depChips.predsCritical ? 'bg-semantic-critical-bg text-semantic-critical' : 'bg-neutral-surface-raised text-neutral-text-secondary'}`}
                    title={`${depChips.predsCount} predecessor${depChips.predsCount !== 1 ? 's' : ''}`}
                  >
                    ←{depChips.predsCount}
                  </span>
                )}
                {depChips.succsCount > 0 && (
                  <span
                    className={`inline-flex items-center px-1 py-px rounded text-xs font-medium cursor-pointer ${depChips.succsCritical ? 'bg-semantic-critical-bg text-semantic-critical' : 'bg-neutral-surface-raised text-neutral-text-secondary'}`}
                    title={`${depChips.succsCount} successor${depChips.succsCount !== 1 ? 's' : ''}`}
                  >
                    →{depChips.succsCount}
                  </span>
                )}
              </span>
            ) : (
              !task.isSummary && !task.isMilestone && <AssigneeChips assignees={task.assignees} />
            )}
          </div>
        )}

        {/* Properties button — absolute within the task column so it never overlaps
            the Dur·Start or % columns. Visible on hover/focus or when selected. */}
        <button
          type="button"
          aria-label={`Open properties for ${task.name}`}
          title="Task properties"
          onClick={(e) => {
            e.stopPropagation();
            setSelectedTaskId(task.id);
          }}
          className={[
            'absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded',
            'text-neutral-text-secondary hover:text-neutral-text-primary',
            'transition-opacity duration-100',
            isSelected
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand-primary dark:focus-visible:ring-semantic-on-track',
          ].join(' ')}
        >
          {/* Horizontal ellipsis */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            <circle cx="2" cy="6" r="1.2" />
            <circle cx="6" cy="6" r="1.2" />
            <circle cx="10" cy="6" r="1.2" />
          </svg>
        </button>
      </div>

      {/* ── Dur column ──────────────────────────────────────────────────────── */}
      {!isEditing &&
        visible.dur &&
        (buildMode && !task.isMilestone ? (
          <EditableCell
            column="duration"
            value={String(task.duration)}
            display={`${task.duration}d`}
            isEditing={editingColumnDuration}
            inputType="duration"
            ariaLabel={`Duration: ${task.duration} days. Press Enter to edit.`}
            className="justify-end shrink-0 border-r border-neutral-border/20 text-right text-neutral-text-secondary tabular-nums pr-2"
            style={{ width: widths.dur }}
            onStartEdit={() => {
              buildMode.focus.focusRow(task.id);
              buildMode.focus.enterCellEdit(task.id, 'duration');
            }}
            onCommit={(parsed) => {
              if (typeof parsed === 'number' && projectId) {
                updateTask.mutate({ id: task.id, projectId, duration: parsed });
              }
              buildMode.focus.commitToRow();
            }}
            onRollback={() => buildMode.focus.rollbackToRow()}
            onTabForward={() => buildMode.focus.tabForward()}
            onTabBackward={() => buildMode.focus.tabBackward()}
          />
        ) : (
          <div
            className="flex items-center justify-end shrink-0 border-r border-neutral-border/20
              text-right text-neutral-text-secondary tabular-nums pr-2"
            style={{ width: widths.dur }}
            role="gridcell"
            aria-label={task.isMilestone ? 'milestone' : `${task.duration} days`}
          >
            {task.isMilestone ? '—' : `${task.duration}d`}
          </div>
        ))}

      {/* ── Start column ────────────────────────────────────────────────────── */}
      {!isEditing && visible.start && (
        <div
          className={[
            'relative flex items-center justify-end shrink-0 border-r border-neutral-border/20',
            'text-right text-neutral-text-secondary tabular-nums pr-2',
            buildMode && task.isMilestone ? 'cursor-pointer hover:text-neutral-text-primary' : '',
          ].join(' ')}
          style={{ width: widths.start }}
          role="gridcell"
          aria-label={task.start ? `starts ${formatDate(task.start)}` : 'unscheduled'}
          tabIndex={buildMode && task.isMilestone ? 0 : undefined}
          onClick={
            buildMode && task.isMilestone
              ? (e) => {
                  e.stopPropagation();
                  setShowMilestonePicker((v) => !v);
                }
              : undefined
          }
          onKeyDown={
            buildMode && task.isMilestone
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setShowMilestonePicker((v) => !v);
                  }
                }
              : undefined
          }
        >
          {task.isMilestone ? formatDate(task.start) : task.start ? formatDate(task.start) : '—'}
          {buildMode && task.isMilestone && (
            <MilestoneDatePopover
              open={showMilestonePicker}
              parents={milestoneParents ?? []}
              onSelect={(iso) => {
                if (projectId) {
                  updateTask.mutate({ id: task.id, projectId, planned_start: iso });
                }
                setShowMilestonePicker(false);
              }}
              onClose={() => setShowMilestonePicker(false)}
            />
          )}
        </div>
      )}

      {/* ── Finish column ───────────────────────────────────────────────────── */}
      {!isEditing && visible.finish && (
        <div
          className="flex items-center justify-end shrink-0 border-r border-neutral-border/20
            text-right text-neutral-text-secondary tabular-nums pr-2"
          style={{ width: widths.finish }}
          role="gridcell"
          aria-label={
            task.isMilestone
              ? 'milestone — single date in Start column'
              : task.finish
                ? `finishes ${formatDate(task.finish)}`
                : 'unscheduled'
          }
        >
          {/* Milestones are single-point gates: render an em-dash so the row
              never displays a date range that contradicts the diamond marker.
              The single date is shown in the Start column (line 564). */}
          {task.isMilestone ? '—' : task.finish ? formatDate(task.finish) : '—'}
        </div>
      )}

      {/* ── % complete column ───────────────────────────────────────────────── */}
      {/*
       * Milestone tasks with a sprint rollup (ADR-0074) render the rolled-up
       * percent as read-only — manual edits are server-rejected with a
       * structured 400. The cell also surfaces a lock affordance and a
       * compact variance pill when the sprint is anchored to the milestone.
       */}
      {!isEditing &&
        visible.progress &&
        (buildMode && !task.isMilestone ? (
          <EditableCell
            column="progress"
            value={String(task.progress)}
            display={`${Math.round(task.progress)}%`}
            isEditing={editingColumnProgress}
            inputType="number"
            ariaLabel={`Progress: ${Math.round(task.progress)}%. Press Enter to edit.`}
            className="justify-end shrink-0 text-right text-neutral-text-secondary tabular-nums pr-2"
            style={{ width: widths.progress }}
            onStartEdit={() => {
              buildMode.focus.focusRow(task.id);
              buildMode.focus.enterCellEdit(task.id, 'progress');
            }}
            onCommit={(parsed) => {
              if (typeof parsed === 'number' && projectId) {
                updateTask.mutate(
                  { id: task.id, projectId, percent_complete: parsed },
                  {
                    onError: (err) => {
                      if (parseProgressAnchorError(err)) {
                        setScheduleError(
                          `Set a Planned Start date (or assign a sprint) before recording progress.`,
                        );
                        setTimeout(() => setScheduleError(null), 5000);
                      } else if (parseMilestoneRollupLockedError(err)) {
                        setScheduleError(
                          `Progress rolls up from sprint(s) — close or unlink to edit.`,
                        );
                        setTimeout(() => setScheduleError(null), 5000);
                      }
                    },
                  },
                );
              }
              buildMode.focus.commitToRow();
            }}
            onRollback={() => buildMode.focus.rollbackToRow()}
            onTabForward={() => buildMode.focus.tabForward()}
            onTabBackward={() => buildMode.focus.tabBackward()}
          />
        ) : (
          <MilestoneProgressCell task={task} widthPx={widths.progress} />
        ))}

      {/* ── Owner column (#248) ─────────────────────────────────────────────── */}
      {/* Summary tasks: empty cell (assignees roll up implicitly, not authored). */}
      {!isEditing && visible.owner && (
        <div
          className="flex items-center shrink-0 pl-2"
          style={{ width: widths.owner }}
          role="gridcell"
          aria-label={
            task.isSummary
              ? 'Summary task — owner column empty'
              : task.assignees.length === 0
                ? 'Owner: none'
                : `Owner: ${task.assignees.map((a) => a.name).join(', ')}`
          }
        >
          {!task.isSummary && <AssigneeChips assignees={task.assignees} size="md" max={3} />}
        </div>
      )}
      {/* Sprint assignment prompt after name commit in agile mode (#346).
          When the commit trips a Tier-1 warn or an Owner-escalated Tier-2 block
          (ADR-0101), the prompt is replaced by the corresponding outcome panel
          anchored to the same position rather than closing silently. */}
      {buildMode && showSprintPrompt && !sprintOutcome && (
        <SprintPrompt
          open={showSprintPrompt}
          projectId={projectId || null}
          onSelect={(sprintId, storyPoints) => {
            if (!projectId) {
              setShowSprintPrompt(false);
              return;
            }
            const priorSprintId = task.sprintId ?? null;
            updateTask.mutate(
              {
                id: task.id,
                projectId,
                sprint: sprintId,
                story_points: storyPoints,
              },
              {
                onSuccess: (data) => {
                  const w = parseGuardrailWarnings(data);
                  if (w.length > 0) {
                    setSprintOutcome({ kind: 'warn', warnings: w, priorSprintId });
                  } else {
                    setShowSprintPrompt(false);
                  }
                },
                onError: (err) => {
                  const b = parseGuardrailBlockedError(err);
                  if (b) {
                    setSprintOutcome({ kind: 'block', detail: b.detail });
                  } else {
                    setShowSprintPrompt(false);
                  }
                },
              },
            );
          }}
          onDismiss={() => setShowSprintPrompt(false)}
        />
      )}
      {buildMode && sprintOutcome && (
        <div className="absolute top-full left-0 z-50 w-[260px] mt-0.5">
          {sprintOutcome.kind === 'warn' ? (
            <GuardrailNotice
              warnings={sprintOutcome.warnings}
              onKeep={() => {
                setSprintOutcome(null);
                setShowSprintPrompt(false);
              }}
              onUndo={() => {
                if (projectId) {
                  // Re-PATCH to the prior sprint to revert the override.
                  updateTask.mutate({
                    id: task.id,
                    projectId,
                    sprint: sprintOutcome.priorSprintId,
                  });
                }
                setSprintOutcome(null);
                setShowSprintPrompt(false);
              }}
            />
          ) : (
            <GuardrailBlock
              detail={sprintOutcome.detail}
              onDismiss={() => {
                setSprintOutcome(null);
                setShowSprintPrompt(false);
              }}
            />
          )}
        </div>
      )}
      {buildMode && menuAnchor && (
        <BuildModeRowMenu
          anchor={menuAnchor}
          items={menuItems}
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </div>
  );
}

/**
 * Default-shallow memoization keeps rows whose `dimmed` flag did not change
 * from re-rendering on hover transitions (#475). Without this, every chain
 * recompute re-renders the full virtualised window — perceived as flash
 * when sweeping the cursor across the task list.
 *
 * Shallow equality is safe because:
 *   - `task`, `siblingIds`, `nameSuggestions`, `milestoneParents`, `depChips`
 *     are derived from upstream useMemo()s and have stable identity across
 *     hover transitions (they only change when the underlying task/link
 *     data changes).
 *   - `onHoverChange` / `onAddDependencyRequest` are stable (useState setter
 *     and useCallback).
 *   - `dimmed` is the boolean that does change per hover — that's the prop
 *     we actually want re-renders to track.
 */
export const TaskListRow = memo(TaskListRowInner);

/**
 * % cell for non-build-mode and milestone rows (ADR-0074).
 *
 * Non-milestone tasks: render the existing percentage value.
 * Milestone tasks: render the rolled-up percent when present (with lock icon
 * + variance pill), otherwise leave the cell empty (today's behaviour).
 */
function MilestoneProgressCell({ task, widthPx }: { task: Task; widthPx: number }) {
  const itl = useIterationLabel();
  const rollup = task.milestoneRollup ?? null;
  const hasRollup =
    task.isMilestone && rollup && rollup.rollup_basis !== 'none' && rollup.percent_complete != null;

  if (task.isMilestone && hasRollup && rollup) {
    const pct = Math.round(rollup.percent_complete!);
    const variance = rollup.variance_days;
    const varianceLabel =
      variance == null
        ? null
        : variance < 0
          ? `${variance}d`
          : variance === 0
            ? '0d'
            : `+${variance}d`;
    const varianceClass =
      variance == null || variance === 0
        ? 'text-neutral-text-secondary'
        : variance < 0
          ? 'text-semantic-on-track'
          : variance <= 5
            ? 'text-semantic-at-risk'
            : 'text-semantic-critical';
    const ariaLabelParts = [`Progress ${pct}% (${itl.lower} rollup, locked)`];
    if (variance != null && variance !== 0) {
      ariaLabelParts.push(
        variance < 0
          ? `${itl.singular} plan ${Math.abs(variance)} days ahead.`
          : `${itl.singular} plan ${variance} days slip.`,
      );
    }
    if (rollup.sprint_scope_changed) {
      ariaLabelParts.push(`${itl.singular} scope changed since activation.`);
    }
    return (
      <div
        className="flex items-center justify-end shrink-0 gap-1
          text-right text-neutral-text-primary tabular-nums pr-2 border-r border-neutral-border/20"
        style={{ width: widthPx }}
        role="gridcell"
        aria-label={ariaLabelParts.join(' ')}
        aria-readonly="true"
        title={ariaLabelParts.join(' ')}
      >
        <span className="tppm-mono">{pct}%</span>
        <span aria-hidden="true" className="text-neutral-text-secondary">
          🔒
        </span>
        {varianceLabel && (
          <span className={`tppm-mono text-xs ${varianceClass}`} aria-hidden="true">
            {varianceLabel}
          </span>
        )}
        {rollup.sprint_scope_changed && rollup.scope_change_sprint_id && (
          <ScopeChangedChip sprintId={rollup.scope_change_sprint_id} iconOnly />
        )}
      </div>
    );
  }

  // Summary/parent rows carry a duration-weighted rollup of child progress, which
  // is fractional (e.g. 31.36); leaf rows are already integers. Round for display so
  // every row reads as a whole percent, matching the milestone-rollup cell above and
  // the Overview KPI cards.
  const pct = Math.round(task.progress);

  return (
    <div
      className="flex items-center justify-end shrink-0
        text-right text-neutral-text-secondary tabular-nums pr-2 border-r border-neutral-border/20"
      style={{ width: widthPx }}
      role="gridcell"
      aria-label={`${pct}% complete`}
    >
      {!task.isMilestone && `${pct}%`}
    </div>
  );
}
