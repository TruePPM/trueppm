import { memo, useState, useRef, useCallback, useEffect } from 'react';
import type React from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import { useIsCoarsePointer } from '@/hooks/useIsCoarsePointer';
import { useEffectiveDurationPolicy } from '@/hooks/useProject';
import { RecalcPercentChip } from './RecalcPercentChip';
import { buildRecalcPrompt, type RecalcPromptState } from './recalcPercentPrompt';
import {
  useProgressAutoStatusConfirm,
  type ProgressAutoStatusConfirm,
} from './useProgressAutoStatusConfirm';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import type { ProjectResource, Task } from '@/types';
import { ROW_HEIGHT, WBS_INDENT } from './scheduleConstants';
import type { RowMode } from './deliveryModePresentation';
import { ModeChip, ModeGutter } from './RowModeIndicators';
import { ScopeChangedChip } from '@/features/sprints/ScopeChangedChip';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import { useScheduleStore, type ScheduleActionToast } from '@/stores/scheduleStore';
import { toast } from '@/components/Toast';
import {
  useUpdateTask,
  useReparentTask,
  useReorderTasks,
  parseMilestoneRollupLockedError,
  parseProgressAnchorError,
  parseGuardrailWarnings,
  parseGuardrailBlockedError,
  useToggleComplete,
  useDuplicateTask,
  type GuardrailWarning,
} from '@/hooks/useTaskMutations';
import { useCreateDependency } from '@/hooks/useDependencyMutations';
import { formatRelative } from '@/lib/formatRelative';
import { milestoneVarianceAnnotation, varianceToneTextClass } from '@/lib/milestoneVariance';
import { DateCellValue } from './reconcile/DateCellValue';
import { cellAriaLabel, describeDivergence } from './reconcile/reconcileCopy';
import { useReconcileEntry, useWorkingDaysMask } from './reconcile/useReconcileEntry';
import { GuardrailNotice } from './sections/GuardrailNotice';
import { GuardrailBlock } from './sections/GuardrailBlock';
import { useDragStore } from '@/stores/dragStore';
import { AssigneeChips } from './AssigneeChips';
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CheckboxIcon,
  CopyIcon,
  IndentIcon,
  LinkIcon,
  LockIcon,
  MilestoneIcon,
  NoteIcon,
  OutdentIcon,
  PencilIcon,
  SeededUntouchedIcon,
  SlidersIcon,
  TrashIcon,
  UndoIcon,
} from '@/components/Icons';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { canEditTask } from '@/lib/roles';
import { MissingCommittedStartChip } from './MissingCommittedStartChip';
import { isMissingCommittedStart } from './missingCommittedStart';
import { LINK_STATUS_TEXT_CLASS } from '@/lib/linkStatus';
import { localTodayIso } from '@/lib/localDate';
import type { PhasePlannedBadge } from './plannedByPhase';
import {
  useBuildMode,
  EditableCell,
  BuildModeRowMenu,
  NameAutocomplete,
  UnresolvedTokenName,
  MilestoneDatePopover,
  SprintPrompt,
  ownerTokensToApiPayload,
  TokenAutocomplete,
  COMMAND_MENU,
  tokenLiteralFor,
  activeTokenFragment,
  applySuggestion,
  commandSuggestions,
  cycleDependencyTypeInDraft,
  resolveAuthoringDraft,
  suggestionsForFragment,
  type ParentCandidate,
  type PredecessorCandidate,
  type RowMenuItem,
} from './buildMode';
import { wbsParentPath } from './buildMode/insertBelow';

interface Props {
  task: Task;
  level: number;
  widths: ColumnWidths['widths'];
  visible: ColumnWidths['visible'];
  hasChildren?: boolean;
  /**
   * Structural children directly under this row (#2956). Drives the fold
   * caret's "N inside" / "N hidden" statement — a caret that folds without
   * saying what it folded leaves the user guessing what disappeared.
   */
  childCount?: number;
  isExpanded?: boolean;
  /**
   * Collapse/expand callback. Takes the task id so the parent can pass its own
   * stable handler directly instead of wrapping it in a per-row closure — a
   * fresh closure per render defeated this memoized row's shallow compare and
   * re-rendered every visible row on every virtualizer scroll frame (issue 1521).
   */
  onToggleId?: (id: string) => void;
  /** Previous visible task id — null at the top. Drives ArrowUp navigation. */
  prevTaskId?: string | null;
  /** Next visible task id — null at the bottom. Drives ArrowDown navigation. */
  nextTaskId?: string | null;
  /**
   * 1-based grid row index for `aria-rowindex` (#2204). The header is row 1, so
   * the panel passes 2-based indices for data rows. Optional so a row rendered
   * outside the grid (tests) still works.
   */
  ariaRowIndex?: number;
  /**
   * Roving-tabindex flag (#2204): true when this row is the single Tab-reachable
   * row in the grid. Defaults to `true` so a standalone row (tests / non-grid
   * use) keeps its historical `tabIndex=0`. When false the row and its per-row
   * controls drop to `tabIndex=-1`, so the whole grid is one tab stop.
   */
  isActiveRow?: boolean;
  /** Reports focus back to the panel so the roving stop follows the focused row. */
  onRowFocus?: (id: string) => void;
  /** Home/End: ask the panel to jump the roving stop to the first/last row. */
  onFocusEdge?: (edge: 'first' | 'last') => void;
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
  /**
   * Every visible row id, top to bottom (#2727 multi-select). Shift+↑/↓
   * selection-extend and ⌘A's "whole tree" expansion are no-ops without it.
   */
  visibleTaskIds?: string[];
  /** Task name suggestions for the inline autocomplete dropdown (#343). */
  nameSuggestions?: string[];
  /**
   * The project's resource roster — the only index the `@owner` authoring token
   * resolves against (ADR-0774, #2718). Absent (or empty) disables the token: no
   * popover, and nothing is stripped from the committed name.
   */
  resourcePool?: ProjectResource[];
  /**
   * Index for the `>predecessor` and `[phase]` authoring tokens (#2722). Scoped to
   * this project by the panel that derives it; absent disables both tokens, which
   * then stay literal text like any other unresolvable token.
   */
  authoringCandidates?: { tasks: PredecessorCandidate[]; phases: ParentCandidate[] };
  /** Parent summary tasks (closest ancestor first) — for milestone date quick-picks (#345). */
  milestoneParents?: { name: string; finish?: string }[];
  /**
   * Hover bus callback (#475) — fires when the cursor enters or leaves the row,
   * and when keyboard focus moves on/off. Wires through ScheduleView to
   * `engine.setHoverChain` so the canvas + task list dim non-chain rows.
   */
  onHoverChange?: (taskId: string | null) => void;
  /**
   * True when this row's task is the shared hovered id (from the table *or* the
   * canvas) — applies a row wash so the table row and its bar read as one unit
   * (#2096). Distinct from CSS `:hover`, which only fires for direct table hover.
   */
  isHovered?: boolean;
  /**
   * Open the dependency picker for this task in the given mode (#477).
   * Lifted to ScheduleView so the modal is a DOM sibling, not embedded in the row.
   */
  onAddDependencyRequest?: (taskId: string, mode: 'predecessor' | 'successor') => void;
  /** Existing sibling names at the row's WBS-parent level — used to suffix "(copy)". */
  siblingNames?: string[];
  /** Source sprint snapshot used by the Undo affordance. Null when not in a sprint. */
  sourceSprint?: { id: string; name: string; state: string } | null;
  /**
   * True when this row was created via "+ Phase" (issue #1754) and has no
   * structural child yet — renders the ghost "Add first task to this phase"
   * affordance in place of the assignee chips. Never true once the row has a
   * structural child (it is then a real phase, per `isPhaseTask`).
   */
  phaseInWaiting?: boolean;
  /** Creates the phase's first structural child (issue #1754). */
  onAddPhaseFirstChild?: (taskId: string) => void;
  /**
   * True for exactly one row (the one just created via "+ Phase" or its
   * ghost "add first task" affordance, issue #1754) when Build Mode is not
   * active — drops the row into the local inline rename input on mount, the
   * same "double-click to rename" path a user would reach by hand.
   */
  startInlineEditOnMount?: boolean;
  /** Fired once this row has started editing from `startInlineEditOnMount`. */
  onAutoEditConsumed?: () => void;
  /**
   * "N planned" badge model (#1798) — present only on a summary/phase row whose
   * subtree holds sprint-assigned backlog. Muted, dashed, notification-silent; a
   * click reveals that work in the Unscheduled tray (never a task action).
   */
  plannedBadge?: PhasePlannedBadge;
  /**
   * Resolved delivery mode for this row (#2737) — `undefined`, or a `gated`
   * kind, renders nothing. Computed once for the whole tree by
   * `computeRowModes`, because a parent's value depends on its descendants.
   */
  rowMode?: RowMode;
  /**
   * Open the classification popover on this row (#2736). Omitted outside
   * Author mode and for roles that cannot edit the plan, which is what removes
   * the row-menu entry rather than rendering it disabled with no explanation.
   */
  onClassifyRequest?: (taskId: string) => void;
}

// On macOS the modifier is labelled "Option"; everywhere else it's "Alt".
const REORDER_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Option' : 'Alt';


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

/** Add n calendar days to an ISO date string. */
function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

type BuildMode = NonNullable<ReturnType<typeof useBuildMode>>;

/**
 * Post-commit sprint-assignment outcome (#875). A `warn` surfaces a
 * GuardrailNotice with one-tap keep/undo (`priorSprintId` reverts); a `block`
 * surfaces an Owner-escalated GuardrailBlock with no override.
 */
type SprintOutcome =
  | { kind: 'warn'; warnings: GuardrailWarning[]; priorSprintId: string | null }
  | { kind: 'block'; detail: string };

/**
 * Context for the build-mode row keyboard reducer. Extracted from
 * TaskListRowInner (#2081) so the branch-dense reducer lives outside the
 * component body; every field is a value the inline handler previously closed
 * over. The extraction is verbatim — branch order and semantics are unchanged.
 */
interface BuildKeyDownCtx {
  buildMode: BuildMode | null;
  anyCellInEdit: boolean;
  siblingIds: string[] | undefined;
  task: Task;
  prevTaskId: string | null;
  nextTaskId: string | null;
  /**
   * Every visible row id, top to bottom (#2727 multi-select) — the flattened
   * order `EXTEND_SELECTION` and ⌘A's "whole tree" set are computed against.
   * Optional so a row rendered outside `TaskListPanel` (tests) still works;
   * Shift+↑/↓ and the ⌘A tree-expand step are no-ops without it.
   */
  visibleTaskIds: string[] | undefined;
  reorderTasks: ReturnType<typeof useReorderTasks>;
  focusRowDom: (id: string) => void;
}

/**
 * Find the contiguous run of `selectedIds` within `siblingIds`, in sibling
 * order. Returns null when any selected id is not one of these siblings
 * (selection spans more than one parent) or the selected ids are not
 * consecutive in sibling order (#2727, ADR-0776 §1: "Alt+↑/↓ is scoped to a
 * contiguous, same-parent selection... a no-op outside that case").
 */
function contiguousSameParentBlock(
  selectedIds: Set<string>,
  siblingIds: string[],
): string[] | null {
  const indices: number[] = [];
  for (const id of selectedIds) {
    const idx = siblingIds.indexOf(id);
    if (idx === -1) return null;
    indices.push(idx);
  }
  indices.sort((a, b) => a - b);
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) return null;
  }
  return indices.map((idx) => siblingIds[idx]);
}

/**
 * Move a contiguous block of siblings one slot up/down by swapping it with
 * the single adjacent sibling outside the block. Returns null when the block
 * is already at that edge of `siblingIds` (out-of-range move, matches the
 * existing single-row no-op-at-the-edge behavior below).
 */
function moveContiguousBlock(
  siblingIds: string[],
  blockIds: string[],
  delta: 1 | -1,
): string[] | null {
  const startIdx = siblingIds.indexOf(blockIds[0]);
  const blockLen = blockIds.length;
  if (delta === 1) {
    const afterIdx = startIdx + blockLen;
    if (afterIdx >= siblingIds.length) return null;
    const neighbor = siblingIds[afterIdx];
    const newOrder = [...siblingIds];
    newOrder.splice(startIdx, blockLen + 1, neighbor, ...blockIds);
    return newOrder;
  }
  const beforeIdx = startIdx - 1;
  if (beforeIdx < 0) return null;
  const neighbor = siblingIds[beforeIdx];
  const newOrder = [...siblingIds];
  newOrder.splice(beforeIdx, blockLen + 1, ...blockIds, neighbor);
  return newOrder;
}

/**
 * Option/Alt+↑/↓ sibling reorder (#347; extended #2727 for multi-select).
 * Returns `true` when the event is an Alt+Arrow reorder (and has been
 * consumed, even if it resolves to a no-op such as an out-of-range move), so
 * the caller stops dispatching. Split from handleBuildModeKeyDown (#2245);
 * single-row branch semantics verbatim.
 */
function tryBuildModeReorder(e: React.KeyboardEvent, ctx: BuildKeyDownCtx): boolean {
  const { buildMode, siblingIds, task, reorderTasks } = ctx;
  if (!(e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && siblingIds)) return false;
  e.preventDefault();
  const delta = e.key === 'ArrowDown' ? 1 : -1;
  const selectedIds = buildMode?.focus.state.selectedIds;
  if (selectedIds && selectedIds.size > 1) {
    const block = contiguousSameParentBlock(selectedIds, siblingIds);
    if (!block) return true;
    const newOrder = moveContiguousBlock(siblingIds, block, delta);
    if (!newOrder) return true;
    reorderTasks.mutate({ parent_path: wbsParentPath(task.wbs), ordered_ids: newOrder });
    return true;
  }
  const currentIdx = siblingIds.indexOf(task.id);
  if (currentIdx === -1) return true;
  const newIdx = currentIdx + delta;
  if (newIdx < 0 || newIdx >= siblingIds.length) return true;
  const newOrder = [...siblingIds];
  newOrder.splice(currentIdx, 1);
  newOrder.splice(newIdx, 0, task.id);
  reorderTasks.mutate({ parent_path: wbsParentPath(task.wbs), ordered_ids: newOrder });
  return true;
}

/**
 * Alt+→/← indent/outdent (#2727, ADR-0776 §6). NOT bound to Tab/Shift-Tab —
 * that was the original v1 binding, but it reproduces the exact WCAG 2.1.2
 * keyboard trap `packages/web/src/features/grid/OutlineMode.tsx` already hit
 * and fixed once (#2192): intercepting every Tab keydown means a keyboard
 * user can never leave the grid, and every escape attempt fires a mutation.
 * Alt+→/← mirrors that fix and frees plain Tab to fall through to native
 * focus traversal, same as everywhere else on the page.
 */
function tryBuildModeIndent(e: React.KeyboardEvent, ctx: BuildKeyDownCtx): boolean {
  const { buildMode, task, visibleTaskIds } = ctx;
  if (!e.altKey || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') || !buildMode) return false;
  e.preventDefault();
  // Structural keys apply to every selected row when a multi-row selection is
  // active (#2727, ADR-0776 §1), sorted into top-to-bottom visible order so a
  // batch indent/outdent reads as one predictable sweep rather than Set
  // iteration order.
  const selectedIds = buildMode.focus.state.selectedIds;
  const targets =
    selectedIds && selectedIds.size > 1
      ? (visibleTaskIds ?? [...selectedIds]).filter((id) => selectedIds.has(id))
      : [task.id];
  if (e.key === 'ArrowRight') targets.forEach((id) => buildMode.indent(id));
  else targets.forEach((id) => buildMode.outdent(id));
  return true;
}

/**
 * Shift+↑/↓ (#2727, ADR-0776 §1): extend or shrink a contiguous multi-row
 * selection from the anchor through the adjacent visible row. A no-op at
 * either edge of the visible list (still consumes the event — Shift+↑ at the
 * top of the grid shouldn't fall through to anything else).
 */
function tryBuildModeSelectExtend(e: React.KeyboardEvent, ctx: BuildKeyDownCtx): boolean {
  const { buildMode, prevTaskId, nextTaskId, visibleTaskIds, focusRowDom } = ctx;
  if (!buildMode || !e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
  if (!visibleTaskIds) return false;
  e.preventDefault();
  const toRowId = e.key === 'ArrowDown' ? nextTaskId : prevTaskId;
  if (!toRowId) return true;
  buildMode.focus.extendSelection(toRowId, visibleTaskIds);
  focusRowDom(toRowId);
  return true;
}

/**
 * ⌘A/Ctrl+A (#2727, ADR-0776 §1): first press selects every sibling of the
 * focused row; a second press while that exact "all siblings" set is already
 * selected expands to the whole visible tree.
 */
function tryBuildModeSelectAll(e: React.KeyboardEvent, ctx: BuildKeyDownCtx): boolean {
  const { buildMode, siblingIds, visibleTaskIds } = ctx;
  if (!buildMode || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'a') return false;
  e.preventDefault();
  if (!siblingIds) return true;
  const current = buildMode.focus.state.selectedIds;
  const alreadyAllSiblings =
    !!current && current.size === siblingIds.length && siblingIds.every((id) => current.has(id));
  if (alreadyAllSiblings && visibleTaskIds) {
    buildMode.focus.selectIds(visibleTaskIds);
  } else {
    buildMode.focus.selectIds(siblingIds);
  }
  return true;
}

/**
 * Arrow up/down row-focus traversal in build mode — move focus to the
 * previous/next visible row (documented in useScheduleFocus; #340 follow-up).
 * Returns `true` when it consumes the event. Split from handleBuildModeKeyDown
 * (#2245); branch semantics verbatim.
 */
function tryBuildModeFocusMove(e: React.KeyboardEvent, ctx: BuildKeyDownCtx): boolean {
  const { buildMode, prevTaskId, nextTaskId, focusRowDom } = ctx;
  if (e.altKey || !buildMode) return false;
  if (e.key === 'ArrowDown' && nextTaskId) {
    e.preventDefault();
    buildMode.focus.focusRow(nextTaskId);
    focusRowDom(nextTaskId);
    return true;
  }
  if (e.key === 'ArrowUp' && prevTaskId) {
    e.preventDefault();
    buildMode.focus.focusRow(prevTaskId);
    focusRowDom(prevTaskId);
    return true;
  }
  return false;
}

/**
 * Build-mode keyboard reducer for a task row. Handles Option/Alt+↑/↓ sibling
 * reorder (#347), Option/Alt+→/← indent/outdent (#2727), arrow-key row focus
 * traversal, single-letter Name cell-edit entry, Delete/Backspace, and Esc.
 * Plain Tab/Shift-Tab is deliberately left alone (see `tryBuildModeIndent`).
 * Returns early
 * (no-op) when build mode is inactive or a cell is being edited. The caller
 * inspects `e.defaultPrevented` afterward to decide whether to run the flag-off
 * shortcuts, so this function's preventDefault contract is load-bearing.
 */
function handleBuildModeKeyDown(e: React.KeyboardEvent, ctx: BuildKeyDownCtx): void {
  const { buildMode, anyCellInEdit, task } = ctx;
  if (!buildMode || anyCellInEdit) return;
  if (tryBuildModeReorder(e, ctx)) return;
  if (tryBuildModeIndent(e, ctx)) return;
  if (tryBuildModeSelectAll(e, ctx)) return;
  if (tryBuildModeSelectExtend(e, ctx)) return;
  if (tryBuildModeFocusMove(e, ctx)) return;
  // Plain Tab/Shift-Tab is deliberately NOT intercepted here — see
  // tryBuildModeIndent's doc comment. It falls through to native browser
  // focus traversal, same as everywhere else on the page.
  // Letter key (single printable, not modified) opens Name cell-edit
  // pre-filled with the typed letter — but we keep it simple in v1 and
  // just enter cell-edit; the user re-types if they want to overwrite.
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && /[a-zA-Z0-9]/.test(e.key)) {
    e.preventDefault();
    buildMode.focus.enterCellEdit(task.id, 'name');
    return;
  }
  // Delete (Backspace/Delete) on focused row — destructive, no confirm, to
  // keep the build path fast. The safety net is the "Deleted — Undo" toast
  // wired into buildMode.deleteTask (ScheduleView, #1762): Undo recreates the
  // task from a pre-delete snapshot. The same path backs the ⋮ menu's Delete.
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    // Structural keys apply to every selected row when a multi-row selection
    // is active (#2727, ADR-0776 §1).
    const selectedIds = buildMode.focus.state.selectedIds;
    if (selectedIds && selectedIds.size > 1) {
      selectedIds.forEach((id) => buildMode.deleteTask(id));
    } else {
      buildMode.deleteTask(task.id);
    }
    return;
  }
  // Esc clears focus.
  if (e.key === 'Escape') {
    e.preventDefault();
    buildMode.focus.clear();
  }
}

/**
 * Context for the row-level keyboard reducer (flag-off + build-mode dispatch).
 * Extracted from TaskListRowInner (#2081). `runBuildKeyDown` is the thin wrapper
 * around handleBuildModeKeyDown so this reducer keeps its "let build mode run
 * first, then fall through to flag-off shortcuts" ordering exactly.
 */
interface RowKeyDownCtx {
  sprintOutcome: unknown;
  buildMode: BuildMode | null;
  runBuildKeyDown: (e: React.KeyboardEvent) => void;
  isEditing: boolean;
  anyCellInEdit: boolean;
  nextTaskId: string | null;
  prevTaskId: string | null;
  isSelected: boolean;
  task: Task;
  setSelectedTaskId: (id: string | null) => void;
  focusRowDom: (id: string) => void;
  onFocusEdge?: (edge: 'first' | 'last') => void;
  handleToggleComplete: () => void;
  handleDuplicate: () => void;
  startEdit: () => void;
}

/**
 * Arrow up/down row selection on the flag-off path (build mode handles its own
 * arrow traversal). Returns `true` when it consumes the event. Split from
 * handleRowKeyDown (#2245); branch semantics verbatim.
 */
function tryRowArrowSelect(e: React.KeyboardEvent, ctx: RowKeyDownCtx): boolean {
  const { buildMode, nextTaskId, prevTaskId, setSelectedTaskId, focusRowDom } = ctx;
  if (buildMode) return false;
  if (e.key === 'ArrowDown' && nextTaskId) {
    e.preventDefault();
    setSelectedTaskId(nextTaskId);
    focusRowDom(nextTaskId);
    return true;
  }
  if (e.key === 'ArrowUp' && prevTaskId) {
    e.preventDefault();
    setSelectedTaskId(prevTaskId);
    focusRowDom(prevTaskId);
    return true;
  }
  return false;
}

/**
 * Enter on a focused row. In build mode it inserts a new row and drops the
 * cursor into its Name cell — sibling below (same parent/depth) by default
 * (#1666), sibling above on Shift, child (one level deeper) on ⌘/Ctrl
 * (#2727); otherwise it toggles row selection. F2 remains the "edit this
 * row's name" affordance. One mental model: Enter always ends with the
 * cursor in an editable Name cell. Split from handleRowKeyDown (#2245).
 */
function handleRowEnter(
  e: Pick<React.KeyboardEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>,
  ctx: RowKeyDownCtx,
): void {
  const { buildMode, task, isSelected, setSelectedTaskId } = ctx;
  if (buildMode) {
    // Shift+Enter = sibling above, ⌘/Ctrl+Enter = child, plain Enter = sibling
    // below (#2727).
    if (e.metaKey || e.ctrlKey) buildMode.insertChild(task.id);
    else if (e.shiftKey) buildMode.insertAbove(task.id);
    else buildMode.insertBelow(task.id);
  } else {
    setSelectedTaskId(isSelected ? null : task.id);
  }
}

/**
 * F2 on a focused row: enter the Name cell edit in build mode, or the classic
 * inline rename otherwise. Split from handleRowKeyDown (#2245); semantics verbatim.
 */
function handleRowF2(ctx: RowKeyDownCtx): void {
  const { buildMode, task, startEdit } = ctx;
  if (buildMode) {
    buildMode.focus.enterCellEdit(task.id, 'name');
  } else {
    startEdit();
  }
}

/**
 * Flag-off keyboard shortcuts for a row, run after the build-mode reducer has
 * declined the event: arrow-key selection, Space→Mark complete (ADR-0066 Q5),
 * ⌘D/Ctrl+D duplicate (Q1), Enter select/insert, and F2 rename. Branch order
 * preserved verbatim from handleRowKeyDown (#2245, originally #2081).
 */
function handleRowShortcuts(e: React.KeyboardEvent, ctx: RowKeyDownCtx): void {
  const { handleToggleComplete, handleDuplicate } = ctx;
  if (tryRowArrowSelect(e, ctx)) return;
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
    handleRowEnter(e, ctx);
    return;
  }
  if (e.key === 'F2') {
    e.preventDefault();
    handleRowF2(ctx);
  }
}

/**
 * Row-level keyboard reducer. Dispatches build-mode keys first (via
 * runBuildKeyDown) and returns if build mode consumed the event, then handles
 * the flag-off shortcuts (via handleRowShortcuts). Branch order preserved
 * verbatim from the previous inline handler (#2081).
 */
function handleRowKeyDown(e: React.KeyboardEvent, ctx: RowKeyDownCtx): void {
  const { sprintOutcome, buildMode, runBuildKeyDown, isEditing, anyCellInEdit, onFocusEdge } = ctx;
  // When the sprint-outcome panel is mounted (warn/block after SprintPrompt
  // committed), any key originating inside it — especially Space typed into
  // the optional reason input, or Esc to dismiss — must not bubble into
  // the row's Mark-Complete / clear-focus shortcuts. ADR-0101 §2: the
  // warn reason field is always optional and never blocked from input.
  if (sprintOutcome && e.target !== e.currentTarget) return;
  // Home/End jump the roving tab stop to the first/last grid row (#2204,
  // role="grid" contract). Only when the row div itself is the target — if the
  // event bubbled up from a cell input/button, Home/End move the caret there
  // instead. Handled ahead of the build-mode reducer since the jump is
  // identical in both modes and neither reducer claims these keys.
  if ((e.key === 'Home' || e.key === 'End') && e.target === e.currentTarget && !isEditing && !anyCellInEdit) {
    e.preventDefault();
    onFocusEdge?.(e.key === 'Home' ? 'first' : 'last');
    return;
  }
  // Build-mode owns Tab/Letter/Delete/Esc on the row; let it run first.
  if (buildMode) {
    runBuildKeyDown(e);
    if (e.defaultPrevented) return;
  }
  if (isEditing || anyCellInEdit) return;
  handleRowShortcuts(e, ctx);
}

/**
 * Context for the build-mode row context-menu item builder. Extracted from
 * TaskListRowInner (#2081); the menu is only built when `buildMode` is present.
 */
interface RowMenuCtx {
  buildMode: BuildMode;
  task: Task;
  level: number;
  isComplete: boolean;
  onAddDependencyRequest: ((taskId: string, mode: 'predecessor' | 'successor') => void) | undefined;
  handleToggleComplete: () => void;
  handleDuplicate: () => void;
  onClassifyRequest: Props['onClassifyRequest'];
}

/**
 * Build the ⋮ context-menu item list for a build-mode row. Item order, keys,
 * hints, disabled predicates, and group boundaries are preserved verbatim from
 * the previous inline `menuItems` array (#2081).
 */
function buildRowMenuItems(ctx: RowMenuCtx): RowMenuItem[] {
  const {
    buildMode,
    task,
    level,
    isComplete,
    onAddDependencyRequest,
    handleToggleComplete,
    handleDuplicate,
    onClassifyRequest,
  } = ctx;
  return [
    {
      key: 'edit',
      label: 'Edit',
      icon: <PencilIcon className="h-4 w-4" aria-hidden="true" />,
      hint: 'F2',
      onSelect: () => buildMode.focus.enterCellEdit(task.id, 'name'),
    },
    {
      key: 'toggle-complete',
      // Toggle copy flip — when the task is already COMPLETE the same
      // action un-marks it (ADR-0066 Q3 / ux-design item 2).
      label: isComplete ? 'Unmark complete' : 'Mark complete',
      icon: isComplete ? (
        <UndoIcon className="h-4 w-4" aria-hidden="true" />
      ) : (
        <CheckboxIcon className="h-4 w-4" aria-hidden="true" />
      ),
      hint: 'Space',
      // Milestones are date points; toggling status on them is meaningless.
      disabled: task.isMilestone,
      onSelect: handleToggleComplete,
    },
    {
      key: 'indent',
      label: 'Indent',
      icon: <IndentIcon className="h-4 w-4" aria-hidden="true" />,
      hint: '⌥→',
      startsGroup: true,
      disabled: level <= 1,
      onSelect: () => buildMode.indent(task.id),
    },
    {
      key: 'outdent',
      label: 'Outdent',
      icon: <OutdentIcon className="h-4 w-4" aria-hidden="true" />,
      hint: '⌥←',
      // Disable outdent at root level (level 1).
      disabled: level <= 1,
      onSelect: () => buildMode.outdent(task.id),
    },
    {
      key: 'add-predecessor',
      label: 'Add predecessor…',
      icon: <ArrowUpRightIcon className="h-4 w-4" aria-hidden="true" />,
      startsGroup: true,
      disabled: !onAddDependencyRequest,
      onSelect: () => onAddDependencyRequest?.(task.id, 'predecessor'),
    },
    {
      key: 'add-successor',
      label: 'Add successor…',
      icon: <ArrowDownLeftIcon className="h-4 w-4" aria-hidden="true" />,
      disabled: !onAddDependencyRequest,
      onSelect: () => onAddDependencyRequest?.(task.id, 'successor'),
    },
    {
      key: 'duplicate',
      label: 'Duplicate',
      icon: <CopyIcon className="h-4 w-4" aria-hidden="true" />,
      hint: '⌘D',
      startsGroup: true,
      onSelect: handleDuplicate,
    },
    {
      // #2736. Reachable from the row menu as well as ⌘⇧M so the act is
      // discoverable without already knowing the shortcut — a classification
      // nobody can find is the same as one that does not exist.
      key: 'classify',
      label: 'Classification…',
      icon: <SlidersIcon className="h-4 w-4" aria-hidden="true" />,
      hint: '⌘⇧M',
      startsGroup: true,
      disabled: !onClassifyRequest,
      onSelect: () => onClassifyRequest?.(task.id),
    },
    {
      key: 'milestone',
      label: 'Convert to milestone',
      icon: <MilestoneIcon className="h-4 w-4" aria-hidden="true" />,
      disabled: task.isMilestone,
      onSelect: () => buildMode.convertToMilestone(task.id),
    },
    {
      key: 'delete',
      label: 'Delete',
      icon: <TrashIcon className="h-4 w-4" aria-hidden="true" />,
      hint: '⌫',
      destructive: true,
      startsGroup: true,
      onSelect: () => buildMode.deleteTask(task.id),
    },
  ];
}

/**
 * Roving-tabindex value for the row (#2204): a row being edited drops out of the
 * tab order entirely (its inputs own focus); otherwise only the grid's single
 * active row is Tab-reachable.
 */
function rowTabIndex(editing: boolean, isActiveRow: boolean): number {
  if (editing) return -1;
  return isActiveRow ? 0 : -1;
}

/**
 * Compose the row container's className. Extracted from TaskListRowInner (#2081)
 * — every token and the selection/hover/dim/pending precedence is verbatim.
 */
function getRowClassName(s: {
  isEditing: boolean;
  anyCellInEdit: boolean;
  buildMode: BuildMode | null;
  isBuildSelected: boolean;
  isSelected: boolean;
  isHovered: boolean;
  dimmed: boolean;
  isStructuralPending: boolean;
}): string {
  const editingCell = s.isEditing || s.anyCellInEdit;
  const selected = s.buildMode ? s.isBuildSelected : s.isSelected;
  const selectionClass =
    selected && !editingCell
      ? 'bg-brand-primary/10 border-l-2 border-brand-primary'
      : // Shared hover wash (#2096) — the `--chrome-row-hover` DS token, which
        // the canvas rowHover band mirrors pixel-for-pixel, so the table row
        // and its bar read as one unit; falls back to CSS :hover otherwise.
        s.isHovered
        ? 'bg-chrome-row-hover'
        : 'hover:bg-chrome-row-hover';
  return [
    'relative group flex items-stretch text-xs border-b border-neutral-border/20',
    // motion-safe transition so the hover-chain dim/un-dim (#475) doesn't
    // snap when the cursor sweeps across many rows — without this the rapid
    // chain recomputes show as flicker.
    'motion-safe:transition-opacity motion-safe:duration-150 motion-safe:ease-out',
    editingCell ? 'cursor-text' : 'cursor-pointer',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary',
    selectionClass,
    // De-emphasis is visual only — a dimmed row stays clickable (#2782). The
    // chain dim used to also carry `pointer-events-none`, which made the state
    // unrecoverable for a pointer user: an inert row never fires `mouseenter`,
    // so the hover that would re-origin (or `mouseleave`-clear) the chain can
    // never happen, and every non-chain row stays dead until focus moves. The
    // #806 fix treated one instance of that (a hover pinned to a deleted task);
    // keeping the rows interactive removes the whole class.
    s.dimmed ? 'opacity-[0.22]' : '',
    s.isStructuralPending ? 'opacity-70 cursor-progress' : '',
  ].join(' ');
}

interface TaskDataCellsProps {
  /** Structural children — how many tasks the Σ rolls up from (#2951). */
  childCount: number;
  isEditing: boolean;
  visible: ColumnWidths['visible'];
  widths: ColumnWidths['widths'];
  buildMode: BuildMode | null;
  task: Task;
  editingColumnDuration: boolean;
  editingColumnProgress: boolean;
  projectId: string;
  updateTask: UpdateTaskMutation;
  setRecalcPrompt: React.Dispatch<React.SetStateAction<RecalcPromptState | null>>;
  effectiveDurationPolicy: ReturnType<typeof useEffectiveDurationPolicy>;
  isCoarsePointer: boolean;
  showMilestonePicker: boolean;
  setShowMilestonePicker: React.Dispatch<React.SetStateAction<boolean>>;
  milestoneParents?: { name: string; finish?: string }[];
  setScheduleError: (message: string | null) => void;
  itl: IterationLabel;
  /** #2639: gates a percent-complete write behind a confirmation naming the
   *  target status when it would trigger the server's silent REVIEW/COMPLETE
   *  auto-promotion; commits immediately otherwise. Owned by TaskListRowInner
   *  (shared with the dialog it renders) so a single confirm gate covers this
   *  row's cell regardless of how deep TaskDataCells nests it. */
  requestProgressCommit: ProgressAutoStatusConfirm['requestCommit'];
}

/**
 * The Dur / Start / Finish / Progress / Owner columns. Each is suppressed while
 * the row's name is being inline-edited and gated by its column-visibility flag
 * (#248). Split out of TaskListRowInner (#2081) — guards and props are verbatim.
 */
function TaskDataCells({
  isEditing,
  visible,
  widths,
  buildMode,
  task,
  editingColumnDuration,
  editingColumnProgress,
  projectId,
  updateTask,
  setRecalcPrompt,
  effectiveDurationPolicy,
  isCoarsePointer,
  childCount,
  showMilestonePicker,
  setShowMilestonePicker,
  milestoneParents,
  setScheduleError,
  itl,
  requestProgressCommit,
}: TaskDataCellsProps) {
  return (
    <>
      {/* ── Dur column ──────────────────────────────────────────────────────── */}
      {!isEditing && visible.dur && (
        <TaskDurationCell
          buildMode={buildMode}
          task={task}
          widthPx={widths.dur}
          childCount={childCount}
          editingColumnDuration={editingColumnDuration}
          projectId={projectId}
          updateTask={updateTask}
          setRecalcPrompt={setRecalcPrompt}
          effectiveDurationPolicy={effectiveDurationPolicy}
          isCoarsePointer={isCoarsePointer}
        />
      )}

      {/* ── Start column ────────────────────────────────────────────────────── */}
      {!isEditing && visible.start && (
        <TaskStartCell
          buildMode={buildMode}
          task={task}
          widthPx={widths.start}
          showMilestonePicker={showMilestonePicker}
          setShowMilestonePicker={setShowMilestonePicker}
          milestoneParents={milestoneParents}
          projectId={projectId}
          updateTask={updateTask}
        />
      )}

      {/* ── Finish column ───────────────────────────────────────────────────── */}
      {!isEditing && visible.finish && <TaskFinishCell task={task} widthPx={widths.finish} />}

      {/* ── % complete column ───────────────────────────────────────────────── */}
      {/*
       * Milestone tasks with a sprint rollup (ADR-0074) render the rolled-up
       * percent as read-only — manual edits are server-rejected with a
       * structured 400. The cell also surfaces a lock affordance and a
       * compact variance pill when the sprint is anchored to the milestone.
       */}
      {!isEditing && visible.progress && (
        <TaskProgressCell
          buildMode={buildMode}
          task={task}
          widthPx={widths.progress}
          editingColumnProgress={editingColumnProgress}
          projectId={projectId}
          updateTask={updateTask}
          setScheduleError={setScheduleError}
          itl={itl}
          requestProgressCommit={requestProgressCommit}
        />
      )}

      {/* ── Owner column (#248) ─────────────────────────────────────────────── */}
      {/* Summary tasks: empty cell (assignees roll up implicitly, not authored). */}
      {!isEditing && visible.owner && <TaskOwnerCell task={task} widthPx={widths.owner} />}
    </>
  );
}

/**
 * Local inline-rename state for the flag-off path (Build Mode drives the richer
 * EditableCell instead). Split out of TaskListRowInner (#2081): the state, the
 * "+ Phase" auto-edit effect and the focus-on-activate step move together
 * because they are one unit — every branch and dependency array is verbatim.
 */
function useRowInlineEdit(ctx: {
  task: Task;
  projectId: string;
  updateTask: UpdateTaskMutation;
  startInlineEditOnMount: boolean;
  onAutoEditConsumed?: () => void;
}) {
  const { task, projectId, updateTask, startInlineEditOnMount, onAutoEditConsumed } = ctx;
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = useCallback(() => {
    setEditValue(task.name);
    setIsEditing(true);
  }, [task.name]);

  // "+ Phase" auto-edit (issue #1754): a freshly created phase (or its first
  // structural child) drops straight into the same inline rename input a
  // double-click reaches — but only outside Build Mode (ScheduleView only
  // sets `startInlineEditOnMount` when Build Mode is off; when it's on,
  // `focus.enterCellEdit` drives the richer EditableCell path instead). The
  // ref guards against re-firing if this row re-renders with the prop still
  // true before the parent clears it.
  const autoEditFiredRef = useRef(false);
  useEffect(() => {
    if (startInlineEditOnMount && !autoEditFiredRef.current) {
      autoEditFiredRef.current = true;
      startEdit();
      onAutoEditConsumed?.();
    }
  }, [startInlineEditOnMount, startEdit, onAutoEditConsumed]);

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

  return { isEditing, editValue, setEditValue, inputRef, startEdit, commitEdit, cancelEdit };
}

/**
 * Per-cell Build Mode focus/edit flags. Split out of TaskListRowInner (#2081) —
 * each `?? false` fallback preserves the flag-off behavior when the
 * BuildModeProvider is not mounted.
 */
function useBuildCellState(buildMode: BuildMode | null, taskId: string) {
  const isBuildSelected = buildMode?.focus.isRowSelected(taskId) ?? false;
  const editingColumnName = buildMode?.focus.isCellInEdit(taskId, 'name') ?? false;
  const editingColumnDuration = buildMode?.focus.isCellInEdit(taskId, 'duration') ?? false;
  const editingColumnProgress = buildMode?.focus.isCellInEdit(taskId, 'progress') ?? false;
  const anyCellInEdit = editingColumnName || editingColumnDuration || editingColumnProgress;
  return {
    isBuildSelected,
    editingColumnName,
    editingColumnDuration,
    editingColumnProgress,
    anyCellInEdit,
  };
}

/**
 * #344: start/stop the build ghost bar as the name cell enters/exits edit mode.
 * Split out of TaskListRowInner (#2081) — the 5-day inclusive default bar and
 * the cleanup-on-unmount contract are verbatim.
 */
function useBuildGhostBar(buildMode: BuildMode | null, editingColumnName: boolean, taskId: string) {
  const startBuilding = useDragStore((s) => s.startBuilding);
  const stopBuilding = useDragStore((s) => s.stopBuilding);
  useEffect(() => {
    if (!buildMode || !editingColumnName) {
      stopBuilding();
      return;
    }
    const today = localTodayIso();
    const defaultFinish = addDaysISO(today, 4); // 5-day inclusive bar
    startBuilding(taskId, today, defaultFinish);
    return () => {
      stopBuilding();
    };
    // startBuilding/stopBuilding are stable store actions, taskId/buildMode are deps that matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingColumnName, buildMode, taskId]);
}

/**
 * #347: pointer handlers for the ⋮⋮ sibling-reorder handle. Split out of
 * TaskListRowInner (#2081) — the row-height quantisation and every no-op guard
 * (no handle down, unknown sibling, zero delta, clamped to range) are verbatim.
 */
function useRowReorderHandle(ctx: {
  buildMode: BuildMode | null;
  siblingIds: string[] | undefined;
  task: Task;
  reorderTasks: ReturnType<typeof useReorderTasks>;
}) {
  const { buildMode, siblingIds, task, reorderTasks } = ctx;
  const reorderHandleRef = useRef<{ startY: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!buildMode || !siblingIds) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    reorderHandleRef.current = { startY: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!reorderHandleRef.current) return;
    e.preventDefault();
  };

  const onPointerUp = (e: React.PointerEvent) => {
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

  return { onPointerDown, onPointerMove, onPointerUp };
}

/**
 * Mark-complete (#477) and Duplicate (#477) row actions. Split out of
 * TaskListRowInner (#2081) — the celebrate-only-on-transition-into-complete
 * capture, the progress-anchor 400 toast, the 4 s auto-clear (#362 pattern) and
 * the ACTIVE-sprint Undo affordance (ADR-0066 Q2) are all verbatim.
 */
function useRowActions(ctx: {
  projectId: string;
  task: Task;
  buildMode: BuildMode | null;
  toggleComplete: ReturnType<typeof useToggleComplete>;
  duplicateTask: ReturnType<typeof useDuplicateTask>;
  updateTask: UpdateTaskMutation;
  siblingNames: string[] | undefined;
  sourceSprint: { id: string; name: string; state: string } | null | undefined;
  setScheduleError: (message: string | null) => void;
  setScheduleActionToast: (toast: ScheduleActionToast | null) => void;
}) {
  const {
    projectId,
    task,
    buildMode,
    toggleComplete,
    duplicateTask,
    updateTask,
    siblingNames,
    sourceSprint,
    setScheduleError,
    setScheduleActionToast,
  } = ctx;

  const handleToggleComplete = useCallback(() => {
    if (!projectId || task.isMilestone) return;
    // Captured before the optimistic flip: only celebrate the transition INTO
    // complete, never un-completing. Warm toast fires on confirmed success.
    const becomingComplete = task.status !== 'COMPLETE';
    toggleComplete.mutate(
      { id: task.id, projectId, previousStatus: task.status },
      {
        onSuccess: () => {
          if (becomingComplete) toast.warm(`Nice — ${task.name} done.`);
        },
        onError: (err) => {
          const anchor = parseProgressAnchorError(err);
          setScheduleError(anchor?.detail ?? 'Failed to update task status.');
          // Auto-clear the error toast after 4 s so it doesn't pin to the
          // bottom of the screen indefinitely (#362 pattern).
          setTimeout(() => setScheduleError(null), 4000);
        },
      },
    );
  }, [
    projectId,
    task.id,
    task.name,
    task.status,
    task.isMilestone,
    toggleComplete,
    setScheduleError,
  ]);

  const handleDuplicate = useCallback(() => {
    if (!projectId) return;
    // Build mode owns the subtree-aware duplicate (#2727, ADR-0776 §2) — it
    // needs the full task tree, which only ScheduleView has. The flag-off
    // path below (no BuildModeProvider mounted) keeps the original
    // single-row-only duplicate exactly as it shipped (ADR-0066 §Q1).
    if (buildMode) {
      buildMode.duplicateSubtree(task.id);
      return;
    }
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
    buildMode,
    task.id,
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

  return { handleToggleComplete, handleDuplicate };
}

/**
 * The ⋮⋮ sibling-reorder grip (#347) — build mode only, revealed on row hover or
 * focus-within and always visible on touch. Split out of TaskListRowInner
 * (#2081); markup and classes verbatim.
 */
function RowReorderHandle({
  handlers,
}: {
  handlers: ReturnType<typeof useRowReorderHandle>;
}) {
  return (
    <div
      className="absolute left-0 inset-y-0 w-3.5 flex items-center justify-center z-10
        opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100
        transition-opacity cursor-grab active:cursor-grabbing
        text-neutral-text-disabled hover:text-neutral-text-secondary"
      title={`Drag to reorder  ·  ${REORDER_KEY}+↑/↓ keyboard`}
      aria-hidden="true"
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
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
  );
}

/**
 * WBS column (#248). Split out of TaskListRowInner (#2081) — the character
 * budget that drives the middle-ellipsis truncation is verbatim.
 */
function RowWbsCell({
  wbs,
  widthPx,
  onIndent,
  onOutdent,
  canOutdent,
  taskName,
}: {
  wbs: string;
  widthPx: number;
  onIndent?: () => void;
  onOutdent?: () => void;
  canOutdent: boolean;
  taskName: string;
}) {
  const showControls = onIndent != null || onOutdent != null;
  return (
    <div
      className="group/wbs flex items-center justify-end shrink-0 border-r border-neutral-border/20
        text-right text-neutral-text-secondary tppm-mono pr-2 text-xs gap-0.5"
      style={{ width: widthPx }}
      role="gridcell"
      aria-label={`WBS ${wbs}`}
      title={wbs}
    >
      {showControls && (
        // Structural nudges live HERE, at the WBS number, because that is where
        // the row's depth is already stated — and deliberately NOT next to
        // delete, which sits alone at the far right of the row. A structural
        // nudge and a destructive act should not be neighbours; mis-hitting one
        // must never cost the other (#2956).
        //
        // Always rendered, at 32% opacity, so the space is reserved and nothing
        // shifts under the pointer on hover.
        <span className="flex items-center opacity-[0.32] focus-within:opacity-100 group-hover/wbs:opacity-100 transition-opacity">
          <button
            type="button"
            tabIndex={-1}
            disabled={!canOutdent}
            onClick={(e) => {
              e.stopPropagation();
              onOutdent?.();
            }}
            // The glyph IS the keyboard notation, so the button documents its
            // own shortcut instead of needing a label.
            aria-label={`Outdent ${taskName} — move it out of its phase`}
            title="Outdent (⌥←)"
            className="w-4 h-4 flex items-center justify-center rounded-control
              hover:text-brand-primary disabled:opacity-40 disabled:cursor-not-allowed
              focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand-primary"
          >
            ⇤
          </button>
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onIndent?.();
            }}
            aria-label={`Indent ${taskName} — move it under the row above`}
            title="Indent (⌥→)"
            className="w-4 h-4 flex items-center justify-center rounded-control
              hover:text-brand-primary
              focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand-primary"
          >
            ⇥
          </button>
        </span>
      )}
      <span className="truncate">
        {truncateWbsPath(wbs, Math.max(3, Math.floor(widthPx / 8) - 1))}
      </span>
    </div>
  );
}

/**
 * Collapse/expand chevron for summary rows; a fixed-width spacer keeps leaf rows
 * aligned. Split out of TaskListRowInner (#2081).
 */
function RowExpandChevron({
  hasChildren,
  isExpanded,
  task,
  onToggleId,
  tabIndex,
  childCount,
}: {
  hasChildren: boolean;
  isExpanded: boolean;
  task: Task;
  onToggleId?: (id: string) => void;
  tabIndex: number;
  childCount: number;
}) {
  if (!hasChildren) return <span className="shrink-0 w-4 mr-0.5" aria-hidden="true" />;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggleId?.(task.id);
      }}
      tabIndex={tabIndex}
      aria-expanded={isExpanded}
      // The count is the point: "Expand Mobilization" tells you nothing about
      // what is behind the caret, and a collapsed phase is otherwise
      // indistinguishable from an empty one (#2956).
      aria-label={
        childCount > 0
          ? isExpanded
            ? `Collapse ${task.name}, ${childCount} inside`
            : `Expand ${task.name}, ${childCount} hidden`
          : isExpanded
            ? `Collapse ${task.name}`
            : `Expand ${task.name}`
      }
      title={
        childCount > 0 ? `${childCount} ${isExpanded ? 'inside' : 'hidden'}` : undefined
      }
      className="shrink-0 w-4 h-4 flex items-center justify-center mr-0.5
        text-neutral-text-secondary hover:text-neutral-text-primary
        focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand-primary rounded-control"
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
  );
}

/**
 * Properties button — absolutely positioned within the task column so it never
 * overlaps the Dur·Start or % columns. Visible on hover/focus or when selected.
 * Split out of TaskListRowInner (#2081).
 */
function RowPropertiesButton({
  task,
  isSelected,
  tabIndex,
  setSelectedTaskId,
}: {
  task: Task;
  isSelected: boolean;
  tabIndex: number;
  setSelectedTaskId: (id: string | null) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Open properties for ${task.name}`}
      title="Task properties"
      tabIndex={tabIndex}
      onClick={(e) => {
        e.stopPropagation();
        setSelectedTaskId(task.id);
      }}
      className={[
        'absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-control',
        'text-neutral-text-secondary hover:text-neutral-text-primary',
        'transition-opacity duration-100',
        // Faintly persistent at rest (not opacity-0) so this is a discoverable
        // way to open the task's full detail drawer without hovering first —
        // in build mode (the desktop default since #2682) a plain row click
        // only focuses the row for keyboard editing, so this button is the
        // only path to the drawer. Same rationale as the Duration-cell pencil
        // icon (#2106): full-strength on hover/focus/selected, faint otherwise.
        isSelected ? 'opacity-100' : 'opacity-40 group-hover:opacity-100 focus-visible:opacity-100',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand-primary',
      ].join(' ')}
    >
      {/* Horizontal ellipsis */}
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <circle cx="2" cy="6" r="1.2" />
        <circle cx="6" cy="6" r="1.2" />
        <circle cx="10" cy="6" r="1.2" />
      </svg>
    </button>
  );
}

/**
 * Row-container pointer/focus handlers. Split out of TaskListRowInner (#2081) so
 * the branch-dense inline arrow functions live at module scope; each guard is
 * verbatim.
 */
interface RowSurfaceCtx {
  isEditing: boolean;
  anyCellInEdit: boolean;
  buildMode: BuildMode | null;
  task: Task;
  isSelected: boolean;
  setSelectedTaskId: (id: string | null) => void;
  startEdit: () => void;
  setMenuAnchor: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  onHoverChange?: (taskId: string | null) => void;
}

function handleRowClick(ctx: RowSurfaceCtx): void {
  if (ctx.isEditing || ctx.anyCellInEdit) return;
  if (ctx.buildMode) {
    ctx.buildMode.focus.focusRow(ctx.task.id);
  } else {
    ctx.setSelectedTaskId(ctx.isSelected ? null : ctx.task.id);
  }
}

function handleRowDoubleClick(ctx: RowSurfaceCtx): void {
  if (ctx.buildMode) {
    // Build-mode double-click → enter Name cell (consistent across all editable cells).
    ctx.buildMode.focus.focusRow(ctx.task.id);
    ctx.buildMode.focus.enterCellEdit(ctx.task.id, 'name');
  } else {
    ctx.startEdit();
  }
}

function handleRowContextMenu(e: React.MouseEvent, ctx: RowSurfaceCtx): void {
  if (!ctx.buildMode) return;
  // #806: suppress right-click while a structural mutation (indent/outdent/
  // delete) is in flight for this row. Opening the menu mid-delete strands
  // the BuildModeRowMenu portal when the row unmounts on cache invalidation,
  // which then blocks subsequent right-clicks on other rows until refresh.
  if (ctx.buildMode.isMutationPending(ctx.task.id)) return;
  e.preventDefault();
  ctx.buildMode.focus.focusRow(ctx.task.id);
  ctx.setMenuAnchor({ x: e.clientX, y: e.clientY });
}

function handleRowBlur(e: React.FocusEvent, ctx: RowSurfaceCtx): void {
  // Only clear hover when focus actually leaves the row, not when it
  // moves to a child element (e.g. EditableCell input).
  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
    ctx.onHoverChange?.(null);
  }
}

/**
 * Row context-menu items, empty outside Build Mode (the menu only opens on a
 * build-mode right-click). Split out of TaskListRowInner (#2081) so the
 * flag-off empty-list branch lives beside the builder it guards.
 */
function buildRowMenuItemsFor(
  buildMode: BuildMode | null,
  ctx: Omit<RowMenuCtx, 'buildMode'>,
): RowMenuItem[] {
  if (!buildMode) return [];
  return buildRowMenuItems({ ...ctx, buildMode });
}

/**
 * Critical-path and summary emphasis for the task-name cell. Split out of
 * TaskListRowInner (#2081); both class strings are verbatim.
 */
function taskNameStyles(task: Task): { isCriticalStyle: string; isSummaryStyle: string } {
  return {
    isCriticalStyle: task.isCritical
      ? 'font-semibold text-semantic-critical'
      : 'text-neutral-text-primary',
    isSummaryStyle: task.isSummary ? 'font-medium' : '',
  };
}

function TaskListRowInner({
  task,
  level,
  widths,
  visible,
  hasChildren = false,
  childCount = 0,
  isExpanded = false,
  onToggleId,
  prevTaskId = null,
  nextTaskId = null,
  ariaRowIndex,
  isActiveRow = true,
  onRowFocus,
  onFocusEdge,
  dimmed = false,
  depChips,
  siblingIds,
  visibleTaskIds,
  nameSuggestions,
  resourcePool,
  authoringCandidates,
  milestoneParents,
  onHoverChange,
  isHovered = false,
  onAddDependencyRequest,
  siblingNames,
  sourceSprint,
  phaseInWaiting = false,
  onAddPhaseFirstChild,
  startInlineEditOnMount = false,
  onAutoEditConsumed,
  plannedBadge,
  rowMode,
  onClassifyRequest,
}: Props) {
  const projectId = useProjectId() ?? '';
  const itl = useIterationLabel(projectId);
  const selectedTaskId = useScheduleStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
  const requestRevealGutterSprint = useScheduleStore((s) => s.requestRevealGutterSprint);
  const setScheduleError = useScheduleStore((s) => s.setScheduleError);
  const setScheduleActionToast = useScheduleStore((s) => s.setScheduleActionToast);
  const isSelected = selectedTaskId === task.id;
  const updateTask = useUpdateTask();
  const { role: currentRole } = useCurrentUserRole(projectId || undefined);
  // Same UX gate the drawer sections use — server capability first, role
  // fallback (`task.canEdit ?? canEditTask(role)`). Gates the remediation
  // actions in the "no committed start" chip popover (web-rules 156/272).
  const canEdit = task.canEdit ?? canEditTask(currentRole);

  // #2639: confirmation gate for the progress=100 auto-status side effect
  // (REVIEW for contributors, COMPLETE for Admin+ — Option E, #381 follow-up),
  // shared with the drawer's OverviewSection via the same hook.
  const { dialog: progressAutoStatusDialog, requestCommit: requestProgressCommit } =
    useProgressAutoStatusConfirm(currentRole);
  const toggleComplete = useToggleComplete();
  const duplicateTask = useDuplicateTask();
  const isCoarsePointer = useIsCoarsePointer();
  const effectiveDurationPolicy = useEffectiveDurationPolicy(projectId);

  // Inline "Recalc %?" prompt state (ADR-0151, issue 1254). Surfaced locally by
  // the editing row when a duration edit changes a task with progress under the
  // effective `confirm` policy; never a modal, never on mobile, never on cascade.
  const [recalcPrompt, setRecalcPrompt] = useState<RecalcPromptState | null>(null);

  const { isEditing, editValue, setEditValue, inputRef, startEdit, commitEdit, cancelEdit } =
    useRowInlineEdit({
      task,
      projectId,
      updateTask,
      startInlineEditOnMount,
      onAutoEditConsumed,
    });

  // ──────────────────────────────────────────────────────────────────────
  // Build-mode wiring (issues #338/#339/#341, gated on the flag — null when
  // the BuildModeProvider is not mounted, in which case all flag-off
  // behavior above remains exactly unchanged).
  // ──────────────────────────────────────────────────────────────────────
  const buildMode = useBuildMode();
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);

  // #347: sibling reorder via Option/Alt+↑/↓ and ⋮⋮ handle
  const reorderTasks = useReorderTasks(projectId || null);

  // #343: name autocomplete state
  const [autocompleteQuery, setAutocompleteQuery] = useState('');

  // #345: milestone date picker visibility
  const [showMilestonePicker, setShowMilestonePicker] = useState(false);

  // #346: sprint prompt visibility
  const [showSprintPrompt, setShowSprintPrompt] = useState(false);

  // #875: outcome state for the post-commit sprint assignment — surfaces a
  // GuardrailNotice (warn, with one-tap override + undo) or GuardrailBlock
  // (Owner-escalated, no override) anchored to the same position as the
  // SprintPrompt so the build-mode user sees the consequence inline without
  // leaving the row. `priorSprintId` lets Undo revert the assignment.
  const [sprintOutcome, setSprintOutcome] = useState<SprintOutcome | null>(null);

  const {
    isBuildSelected,
    editingColumnName,
    editingColumnDuration,
    editingColumnProgress,
    anyCellInEdit,
  } = useBuildCellState(buildMode, task.id);

  useBuildGhostBar(buildMode, editingColumnName, task.id);

  // Move keyboard focus to a sibling row by data-row-id selector. Used by both
  // the build-mode and flag-off arrow-key handlers so the destination row
  // becomes the active element and subsequent arrows continue to traverse.
  const focusRowDom = useCallback((id: string) => {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
      el?.focus();
    });
  }, []);

  // Thin wrapper so the row's onKeyDown can run build-mode keys first and then
  // inspect e.defaultPrevented; the reducer itself lives at module scope (#2081).
  const handleBuildKeyDown = (e: React.KeyboardEvent) =>
    handleBuildModeKeyDown(e, {
      buildMode,
      anyCellInEdit,
      siblingIds,
      visibleTaskIds,
      task,
      prevTaskId,
      nextTaskId,
      reorderTasks,
      focusRowDom,
    });

  const reorderHandlers = useRowReorderHandle({ buildMode, siblingIds, task, reorderTasks });

  const { handleToggleComplete, handleDuplicate } = useRowActions({
    projectId,
    task,
    buildMode,
    toggleComplete,
    duplicateTask,
    updateTask,
    siblingNames,
    sourceSprint,
    setScheduleError,
    setScheduleActionToast,
  });

  const isComplete = task.status === 'COMPLETE';
  const menuItems: RowMenuItem[] = buildRowMenuItemsFor(buildMode, {
    task,
    level,
    isComplete,
    onAddDependencyRequest,
    handleToggleComplete,
    handleDuplicate,
    onClassifyRequest,
  });

  const { isCriticalStyle, isSummaryStyle } = taskNameStyles(task);

  // Data-integrity warning (issue #317): a task that has reached IN_PROGRESS /
  // REVIEW / COMPLETE without a PM-committed `planned_start` is a data error,
  // not "needs scheduling". Shared predicate so the row chip and the drawer
  // advisory (#2314) flag the identical condition (ADR-0603).
  const hasMissingDatesWarning = isMissingCommittedStart(task);

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

  // Roving tabindex (#2204): only the grid's single active row is Tab-reachable;
  // its per-row controls (chevron, properties) ride the same flag so an inactive
  // row contributes zero tab stops, while the active row's controls stay reachable
  // by Tab. A row being edited drops out entirely (its inputs own focus).
  const rovingRowTabIndex = rowTabIndex(isEditing || anyCellInEdit, isActiveRow);
  const rovingChildTabIndex = isActiveRow ? 0 : -1;

  const surface: RowSurfaceCtx = {
    isEditing,
    anyCellInEdit,
    buildMode,
    task,
    isSelected,
    setSelectedTaskId,
    startEdit,
    setMenuAnchor,
    onHoverChange,
  };

  return (
    <div
      role="row"
      data-row-id={task.id}
      aria-rowindex={ariaRowIndex}
      // Treegrid semantics (#2727): level is the row's WBS depth (1-based,
      // matching aria-level's convention directly); aria-expanded is present
      // only on rows that actually have children — a leaf row must omit it
      // entirely rather than carry aria-expanded="false", which would
      // incorrectly claim it's expandable.
      aria-level={level}
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-selected={buildMode ? isBuildSelected : isSelected}
      tabIndex={rovingRowTabIndex}
      style={{ height: ROW_HEIGHT }}
      className={getRowClassName({
        isEditing,
        anyCellInEdit,
        buildMode,
        isBuildSelected,
        isSelected,
        isHovered,
        dimmed,
        isStructuralPending,
      })}
      onClick={() => handleRowClick(surface)}
      onDoubleClick={() => handleRowDoubleClick(surface)}
      onContextMenu={(e) => handleRowContextMenu(e, surface)}
      onMouseEnter={() => onHoverChange?.(task.id)}
      onMouseLeave={() => onHoverChange?.(null)}
      onFocus={() => {
        // A row that is being typed into is not being *pointed at*: skip the
        // chain highlight while any of its cells is in edit (#2782). Build mode
        // creates a row and focuses its name cell programmatically, so without
        // this gate the 80ms `HOVER_SETTLE_MS` fires ~80ms after every quick-add
        // and dims the entire rest of the list on a chain of {the new row} —
        // which carries no information (a brand-new task has no dependencies)
        // and, because the pointer is nowhere near the list, no `mouseleave`
        // ever arrives to clear it.
        if (!isEditing && !anyCellInEdit) onHoverChange?.(task.id);
        // Move the grid's roving tab stop to whichever row gains focus (#2204),
        // so Tab out-and-back returns to the last-focused row (mirrors the
        // overlay's onFocus → setFocusedTaskId).
        onRowFocus?.(task.id);
      }}
      onBlur={(e) => handleRowBlur(e, surface)}
      onKeyDown={(e) =>
        handleRowKeyDown(e, {
          sprintOutcome,
          buildMode,
          runBuildKeyDown: handleBuildKeyDown,
          isEditing,
          anyCellInEdit,
          nextTaskId,
          prevTaskId,
          isSelected,
          task,
          setSelectedTaskId,
          focusRowDom,
          onFocusEdge,
          handleToggleComplete,
          handleDuplicate,
          startEdit,
        })
      }
    >
      {/* ── Delivery-mode gutter (#2737) ─────────────────────────────────────
          Rendered first so it sits under every cell's own background; it is
          absolutely positioned and pointer-events-none, so it never intercepts
          a row click or a cell edit. */}
      <ModeGutter mode={rowMode} />

      {/* ── ⋮⋮ reorder handle — build mode only, visible on row hover (#347) ── */}
      {buildMode && siblingIds && <RowReorderHandle handlers={reorderHandlers} />}

      {/* ── WBS column (#248) ───────────────────────────────────────────────── */}
      {/* Insert-below affordance (#2957). On the row's BOTTOM EDGE, because that
          is where the new row will appear — the single "Add task" button at the
          foot of the list did the cursor's bidding from somewhere its position
          did not imply, which reads as a bug.

          Out of the tab order on purpose: a tab stop per row would make a
          40-row outline unnavigable. Its keyboard twin is `⏎`, which already
          inserts a sibling below the focused row and is what the coach bar and
          the cheatsheet teach — so this is a pointer affordance for an operation
          the keyboard already has, not a pointer-only capability. It still
          carries `focus:opacity-100` so programmatic focus reveals it. */}
      {canEdit && buildMode && (
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            buildMode.insertBelow(task.id);
          }}
          aria-label={`Insert an item below ${task.name || 'this row'}, at the same level`}
          title="Insert an item here"
          className="absolute left-0 bottom-0 translate-y-1/2 z-10 ml-1 w-4 h-4
            flex items-center justify-center rounded-full
            border border-neutral-border bg-neutral-surface-raised
            text-xs leading-none text-neutral-text-secondary
            opacity-0 group-hover:opacity-100 focus:opacity-100
            hover:text-brand-primary hover:border-brand-primary
            focus:outline-none focus:ring-2 focus:ring-brand-primary
            transition-opacity"
          style={{ marginLeft: 4 + (level - 1) * 12 }}
        >
          +
        </button>
      )}

      {visible.wbs && (
        <RowWbsCell
          wbs={task.wbs}
          widthPx={widths.wbs}
          taskName={task.name}
          canOutdent={level > 1}
          // Absent, not disabled, without edit rights — web rule 302 (#2949).
          onIndent={canEdit && buildMode ? () => buildMode.indent(task.id) : undefined}
          onOutdent={canEdit && buildMode ? () => buildMode.outdent(task.id) : undefined}
        />
      )}

      {/* ── Task column ─────────────────────────────────────────────────────── */}
      {/* Positioned wrapper carries the WBS indent. Properties button lives here
          so it never overlaps the Dur·Start or % columns. role="gridcell" (#2204)
          so the Task-name column is a cell like every sibling column, not a bare
          div that would leave the row's gridcell set incomplete. */}
      <div
        role="gridcell"
        className="relative flex items-center shrink-0 border-r border-neutral-border/20"
        style={{ width: widths.task, paddingLeft: (level - 1) * WBS_INDENT + 8 }}
      >
        {/* Collapse/expand chevron for summary tasks */}
        <RowExpandChevron
          hasChildren={hasChildren}
          childCount={childCount}
          isExpanded={isExpanded}
          task={task}
          onToggleId={onToggleId}
          tabIndex={rovingChildTabIndex}
        />

        {/* Seeded-and-untouched tick (#2731, ADR-0799 §4) — a machine wrote this
            row and nobody has looked at it yet. Disappears the moment anyone
            touches the row (`isUntouchedSeed` flips false server-side), so it
            never lingers as stale provenance chrome. */}
        {task.isUntouchedSeed && (
          <SeededUntouchedIcon
            className="mr-1 inline-block h-3 w-3 shrink-0 align-[-0.125em] text-neutral-text-secondary"
            aria-hidden="true"
            data-testid="seeded-untouched-glyph"
          />
        )}

        {/* Milestone diamond indicator */}
        {task.isMilestone && (
          <MilestoneIcon
            className="mr-1 inline-block h-3 w-3 align-[-0.125em] text-brand-accent"
            aria-hidden="true"
            data-testid="milestone-glyph"
          />
        )}

        {/* Task name — inline input when editing.
            Build-mode uses the EditableCell primitive (Tab traverses to next
            cell). Flag-off path keeps the existing simple input (legacy behavior). */}
        <TaskNameContent
          buildMode={buildMode}
          editingColumnName={editingColumnName}
          task={task}
          projectId={projectId}
          updateTask={updateTask}
          setShowSprintPrompt={setShowSprintPrompt}
          autocompleteQuery={autocompleteQuery}
          setAutocompleteQuery={setAutocompleteQuery}
          nameSuggestions={nameSuggestions}
          resourcePool={resourcePool}
          authoringCandidates={authoringCandidates}
          isEditing={isEditing}
          inputRef={inputRef}
          editValue={editValue}
          setEditValue={setEditValue}
          commitEdit={commitEdit}
          cancelEdit={cancelEdit}
          isCriticalStyle={isCriticalStyle}
          isSummaryStyle={isSummaryStyle}
          taskNameWidth={taskNameWidth}
          rowMode={rowMode}
          plannedBadge={plannedBadge}
          requestRevealGutterSprint={requestRevealGutterSprint}
          itl={itl}
          canEdit={canEdit}
          hasMissingDatesWarning={hasMissingDatesWarning}
          recalcPrompt={recalcPrompt}
          setRecalcPrompt={setRecalcPrompt}
          isSelected={isSelected}
          depChips={depChips}
          phaseInWaiting={phaseInWaiting}
          onAddPhaseFirstChild={onAddPhaseFirstChild}
        />

        {/* Properties button — absolute within the task column so it never overlaps
            the Dur·Start or % columns. Faintly visible at rest, full-strength on
            hover/focus or when selected (#2106 pattern) — the only path to the
            task detail drawer while build mode owns the row click. */}
        <RowPropertiesButton
          task={task}
          isSelected={isSelected}
          tabIndex={rovingChildTabIndex}
          setSelectedTaskId={setSelectedTaskId}
        />
      </div>

      <TaskDataCells
        childCount={childCount}
        isEditing={isEditing}
        visible={visible}
        widths={widths}
        buildMode={buildMode}
        task={task}
        editingColumnDuration={editingColumnDuration}
        editingColumnProgress={editingColumnProgress}
        projectId={projectId}
        updateTask={updateTask}
        setRecalcPrompt={setRecalcPrompt}
        effectiveDurationPolicy={effectiveDurationPolicy}
        isCoarsePointer={isCoarsePointer}
        showMilestonePicker={showMilestonePicker}
        setShowMilestonePicker={setShowMilestonePicker}
        milestoneParents={milestoneParents}
        setScheduleError={setScheduleError}
        itl={itl}
        requestProgressCommit={requestProgressCommit}
      />
      {progressAutoStatusDialog}
      {/* Sprint assignment prompt after name commit in agile mode (#346).
          When the commit trips a Tier-1 warn or an Owner-escalated Tier-2 block
          (ADR-0101), the prompt is replaced by the corresponding outcome panel
          anchored to the same position rather than closing silently. */}
      <SprintAssignmentRegion
        buildMode={buildMode}
        showSprintPrompt={showSprintPrompt}
        sprintOutcome={sprintOutcome}
        setSprintOutcome={setSprintOutcome}
        setShowSprintPrompt={setShowSprintPrompt}
        projectId={projectId}
        task={task}
        updateTask={updateTask}
      />
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
 *   - `onToggleId` takes the task id, so the parent passes its own stable
 *     handler straight through instead of a per-row `() => onToggle(id)`
 *     closure. The closure form allocated a fresh function every render,
 *     failing this shallow compare and re-rendering every visible row on every
 *     virtualizer scroll frame (issue 1521).
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
type MilestoneRollup = NonNullable<Task['milestoneRollup']>;

interface MilestoneRollupDisplay {
  pct: number;
  varianceLabel: string | null;
  varianceClass: string;
  ariaLabel: string;
}

/** Signed day label for a milestone variance ("-2d" / "0d" / "+3d"), or null. */
function formatVarianceDays(variance: number | null): string | null {
  if (variance == null) return null;
  if (variance < 0) return `${variance}d`;
  if (variance === 0) return '0d';
  return `+${variance}d`;
}

/**
 * Derive the milestone-rollup cell's percent, variance pill label/color, and the
 * composed aria-label. CPM annotation (issue 551) folds float/critical-path from
 * task.isCritical / task.totalFloat (already on TaskSerializer — no new API).
 */
function deriveMilestoneRollupDisplay(
  rollup: MilestoneRollup,
  task: Task,
  itl: IterationLabel,
): MilestoneRollupDisplay {
  const pct = Math.round(rollup.percent_complete!);
  const variance = rollup.variance_days;
  const { tone, annotation, ariaAnnotation } = milestoneVarianceAnnotation({
    varianceDays: variance,
    totalFloatDays: task.totalFloat,
    onCriticalPath: task.isCritical,
  });
  const baseVarianceLabel = formatVarianceDays(variance);
  const varianceLabel =
    baseVarianceLabel && annotation ? `${baseVarianceLabel} · ${annotation}` : baseVarianceLabel;
  const varianceClass =
    variance == null || variance === 0 ? 'text-neutral-text-secondary' : varianceToneTextClass(tone);
  const ariaLabelParts = [`Progress ${pct}% (${itl.lower} rollup, locked)`];
  if (variance != null && variance !== 0) {
    const slipPhrase =
      variance < 0
        ? `${itl.singular} plan ${Math.abs(variance)} days ahead`
        : `${itl.singular} plan ${variance} days slip`;
    ariaLabelParts.push(ariaAnnotation ? `${slipPhrase}, ${ariaAnnotation}.` : `${slipPhrase}.`);
  }
  if (rollup.sprint_scope_changed) {
    ariaLabelParts.push(`${itl.singular} scope changed since activation.`);
  }
  return { pct, varianceLabel, varianceClass, ariaLabel: ariaLabelParts.join(' ') };
}

/** Read-only milestone-rollup progress cell (ADR-0074) — percent + lock + variance pill. */
function MilestoneRollupCell({
  task,
  widthPx,
  rollup,
}: {
  task: Task;
  widthPx: number;
  rollup: MilestoneRollup;
}) {
  const itl = useIterationLabel();
  const { pct, varianceLabel, varianceClass, ariaLabel } = deriveMilestoneRollupDisplay(
    rollup,
    task,
    itl,
  );
  return (
    <div
      className="flex items-center justify-end shrink-0 gap-1
          text-right text-neutral-text-primary tabular-nums pr-2 border-r border-neutral-border/20"
      style={{ width: widthPx }}
      role="gridcell"
      aria-label={ariaLabel}
      aria-readonly="true"
      title={ariaLabel}
    >
      <span className="tppm-mono">{pct}%</span>
      <LockIcon
        aria-hidden="true"
        className="h-3 w-3 shrink-0 text-neutral-text-secondary"
        data-testid="milestone-rollup-lock"
      />
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

function MilestoneProgressCell({ task, widthPx }: { task: Task; widthPx: number }) {
  const rollup = task.milestoneRollup ?? null;
  const hasRollup =
    task.isMilestone && rollup && rollup.rollup_basis !== 'none' && rollup.percent_complete != null;

  if (task.isMilestone && hasRollup && rollup) {
    return <MilestoneRollupCell task={task} widthPx={widthPx} rollup={rollup} />;
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

type UpdateTaskMutation = ReturnType<typeof useUpdateTask>;
type IterationLabel = ReturnType<typeof useIterationLabel>;

/**
 * Task-name cell content — the build-mode EditableCell, the flag-off inline
 * rename input, and the read view with its inline chips (note freshness,
 * "N planned", missing-dates, recalc prompt, external links, dep chips,
 * assignee chips, phase-in-waiting). Extracted from TaskListRowInner verbatim
 * (#2081); every branch and attribute is preserved.
 */
interface TaskNameContentProps {
  buildMode: BuildMode | null;
  editingColumnName: boolean;
  task: Task;
  projectId: string;
  updateTask: UpdateTaskMutation;
  setShowSprintPrompt: React.Dispatch<React.SetStateAction<boolean>>;
  autocompleteQuery: string;
  setAutocompleteQuery: React.Dispatch<React.SetStateAction<string>>;
  nameSuggestions: Props['nameSuggestions'];
  resourcePool: Props['resourcePool'];
  authoringCandidates: Props['authoringCandidates'];
  isEditing: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  editValue: string;
  setEditValue: (value: string) => void;
  commitEdit: () => void;
  cancelEdit: () => void;
  isCriticalStyle: string;
  isSummaryStyle: string;
  taskNameWidth: number;
  rowMode: Props['rowMode'];
  plannedBadge: Props['plannedBadge'];
  requestRevealGutterSprint: (sprintId: string | null) => void;
  itl: IterationLabel;
  canEdit: boolean;
  hasMissingDatesWarning: boolean;
  recalcPrompt: RecalcPromptState | null;
  setRecalcPrompt: React.Dispatch<React.SetStateAction<RecalcPromptState | null>>;
  isSelected: boolean;
  depChips: Props['depChips'];
  phaseInWaiting: boolean;
  onAddPhaseFirstChild: Props['onAddPhaseFirstChild'];
}

/**
 * Build-mode Name cell in edit state: the inline EditableCell plus its
 * name-autocomplete popover. Split out of TaskNameContent (#2245) so each render
 * branch stays under the cognitive-complexity budget; markup is verbatim.
 *
 * The cell also hosts the `@owner` authoring token (ADR-0774, #2718). While the caret
 * sits inside an `@…` fragment the owner picker replaces the name-suggestion popover —
 * two listboxes in one cell would fight over the same Arrow/Enter keys — and on commit
 * the draft is split into a task name and a set of `TaskResource` assignments.
 */
function TaskNameBuildEditCell(props: TaskNameContentProps) {
  const {
    buildMode,
    task,
    projectId,
    updateTask,
    setShowSprintPrompt,
    autocompleteQuery,
    setAutocompleteQuery,
    nameSuggestions,
    resourcePool,
    authoringCandidates,
  } = props;
  const pool = resourcePool ?? [];
  const suggestionContext = {
    pool,
    tasks: authoringCandidates?.tasks ?? [],
    phases: authoringCandidates?.phases ?? [],
  };
  // `autocompleteQuery` carries the whole live draft (EditableCell's `onQueryChange`),
  // so the active token is derivable without EditableCell exposing its internal state.
  // A picker the author dismissed with Esc stays shut until the draft changes —
  // Esc must not touch the text, so the query alone cannot record the dismissal.
  // The `[phase]` and `>predecessor` tokens each write through their own endpoint
  // rather than the task PATCH — see the commit handler below for why.
  const reparentTask = useReparentTask(projectId);
  const createDependency = useCreateDependency(projectId);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [draftOverride, setDraftOverride] = useState<{ value: string } | null>(null);
  const pickersSuppressed = dismissedFor === autocompleteQuery;
  const tokenFragment = pickersSuppressed ? null : activeTokenFragment(autocompleteQuery);
  const tokenPicker = tokenFragment
    ? suggestionsForFragment(tokenFragment, suggestionContext)
    : null;
  // The `/` command menu is every token plus every toolbar action, discoverable by
  // typing. It is checked separately from the sigil pickers because it does not
  // complete a token — it INSERTS one and hands the caret to that token's picker.
  const slashAt = pickersSuppressed ? -1 : autocompleteQuery.lastIndexOf('/');
  const slashOpen =
    slashAt >= 0 &&
    (slashAt === 0 || /\s/.test(autocompleteQuery[slashAt - 1])) &&
    !/\s/.test(autocompleteQuery.slice(slashAt + 1));
  const slashFragment = slashOpen
    ? { start: slashAt, query: autocompleteQuery.slice(slashAt + 1) }
    : null;
  if (!buildMode) return null;
  // A row `insertBelow` just created carries a non-blank placeholder name
  // (the API rejects blank on create), but renders blank here until the user
  // types — keeps the "type over it" UX and the double-Enter no-op guard
  // both reading "blank until touched", same as before the placeholder fix
  // (#2682 follow-up).
  const isPristine = buildMode.isPristineNewRow?.(task.id) ?? false;
  const clearPristine = () => buildMode.clearPristineNewRow?.(task.id);
  const isCaretAtEnd = buildMode.isCaretAtEndRow(task.id);
  const clearCaretAtEnd = () => buildMode.clearCaretAtEndRow(task.id);
  return (
    <div className="relative flex-1 min-w-0">
      <EditableCell
        column="name"
        value={isPristine ? '' : task.name}
        isEditing={true}
        inputType="text"
        ariaLabel={`Rename task ${task.name}`}
        className="flex-1 min-w-0 w-full"
        caretPosition={isCaretAtEnd ? 'end' : 'select-all'}
        onEmptyBackspace={() => buildMode.mergeIntoPreviousRow(task.id)}
        onStartEdit={() => {
          /* already editing */
        }}
        onCommit={(parsed) => {
          clearPristine();
          clearCaretAtEnd();
          if (typeof parsed === 'string' && projectId) {
            // Split the draft into name + owners. A token that matches no roster member
            // is left in the name verbatim and the row still commits (ADR-0774 §6) —
            // the alternative, silently dropping it, is the zero-capacity failure this
            // whole contract exists to prevent.
            const parse = resolveAuthoringDraft(parsed, suggestionContext);
            updateTask.mutate({
              id: task.id,
              projectId,
              name: parse.name || parsed,
              ...(parse.owners.length > 0
                ? { owners: ownerTokensToApiPayload(parse.owners) }
                : {}),
              ...(parse.duration !== null ? { duration: parse.duration } : {}),
              ...(parse.isMilestone ? { is_milestone: true } : {}),
              // delivery_mode is sent only when the row did not resolve to a
              // milestone: the two are coupled server-side, so sending both would
              // re-litigate a conflict the parser has already settled.
              ...(parse.deliveryMode && !parse.isMilestone
                ? { delivery_mode: parse.deliveryMode }
                : {}),
            });
            // `parent` and `predecessors` are NOT writable on the task serializer —
            // `parent_id` is explicitly read-only and the only dependency field is a
            // read-only `predecessor_count`. Sending them on the PATCH would be
            // silently ignored, which is exactly the "looks applied, did nothing"
            // failure the token contract exists to prevent. Each has its own endpoint.
            if (parse.parentId && parse.parentId !== task.id) {
              reparentTask.mutate({ taskId: task.id, newParentId: parse.parentId });
            }
            for (const predecessor of parse.predecessors) {
              createDependency.mutate({
                predecessor: predecessor.taskId,
                successor: task.id,
                dep_type: predecessor.depType,
                lag: predecessor.lag,
              });
            }
            setShowSprintPrompt(true);
          }
          setAutocompleteQuery('');
          buildMode.focus.commitToRow();
        }}
        onRollback={() => {
          // Esc on a still-pristine row discards it rather than rolling back
          // (#2727, ADR-0776 §4) — there is no "last committed value" to
          // revert to, since it was never committed in the first place. A
          // row that has ever been committed, rolled back once, or had a
          // real value typed is no longer pristine and gets the ordinary
          // revert-to-last-committed-value behavior below.
          if (isPristine) {
            setAutocompleteQuery('');
            buildMode.deleteTask(task.id);
            buildMode.focus.clear();
            return;
          }
          clearCaretAtEnd();
          setAutocompleteQuery('');
          buildMode.focus.rollbackToRow();
        }}
        onTabForward={() => buildMode.focus.tabForward()}
        onTabBackward={() => buildMode.focus.tabBackward()}
        onQueryChange={(q) => {
          if (q !== '') {
            clearPristine();
            clearCaretAtEnd();
          }
          setAutocompleteQuery(q);
        }}
        // Commit-and-continue (#1666, extended #2727): Enter in the Name cell
        // commits, then inserts a new row and drops into its Name cell —
        // sibling below by default, sibling above (Shift) or child (⌘/Ctrl)
        // per modifier. A blank Name (emptyIsNoop) makes the second Enter a
        // calm no-op.
        onEnterCommit={(mods) => {
          if (mods.metaKey || mods.ctrlKey) buildMode.insertChild(task.id);
          else if (mods.shiftKey) buildMode.insertAbove(task.id);
          else buildMode.insertBelow(task.id);
        }}
        emptyIsNoop
        draftOverride={draftOverride}
        onInputKeyDown={(e) => {
          // ⌥→ / ⌥← cycle the dependency type of the predecessor token under the
          // caret (FS → SS → FF → SF). It rewrites the draft rather than committing
          // anything, so it runs ahead of EditableCell's own key handling.
          if (!e.altKey || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
          const next = cycleDependencyTypeInDraft(
            autocompleteQuery,
            e.currentTarget.selectionStart ?? autocompleteQuery.length,
            e.key === 'ArrowRight' ? 1 : -1,
          );
          // Null means the caret is not on a predecessor token — let the keystroke
          // through rather than swallowing an arrow key meant for cursor movement.
          if (next === null) return;
          e.preventDefault();
          setAutocompleteQuery(next);
          setDraftOverride({ value: next });
        }}
      />
      {slashFragment && commandSuggestions(slashFragment.query).length > 0 && (
        <TokenAutocomplete
          suggestions={commandSuggestions(slashFragment.query)}
          ariaLabel="Insert"
          onSelect={(picked) => {
            // A command inserts its sigil and hands the caret to that token's own
            // picker — it never completes a value itself. One grammar, two ways in.
            const entry = COMMAND_MENU.find((c) => c.id === picked.id);
            if (!entry) return;
            const next = applySuggestion(autocompleteQuery, slashFragment, entry.insert);
            setAutocompleteQuery(next);
            setDraftOverride({ value: next });
          }}
          onDismiss={() => setDismissedFor(autocompleteQuery)}
        />
      )}
      {!slashFragment && tokenFragment && tokenPicker && tokenPicker.suggestions.length > 0 && (
        <TokenAutocomplete
          suggestions={tokenPicker.suggestions}
          ariaLabel={tokenPicker.ariaLabel}
          onSelect={(picked) => {
            const literal = tokenLiteralFor(tokenFragment.kind, picked);
            const next = applySuggestion(autocompleteQuery, tokenFragment, literal);
            setAutocompleteQuery(next);
            // Rewrite the draft rather than commit: focus never leaves the row, and
            // the author may still be adding tokens.
            setDraftOverride({ value: next });
          }}
          onDismiss={() => setDismissedFor(autocompleteQuery)}
        />
      )}
      {!slashFragment && !tokenFragment && nameSuggestions && (
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
  );
}

/**
 * Name cell in classic inline-edit state (double-click rename outside build
 * mode). Split from TaskNameContent (#2245); behavior and markup verbatim.
 */
function TaskNameEditInput(props: TaskNameContentProps) {
  const { inputRef, editValue, setEditValue, commitEdit, cancelEdit, task } = props;
  return (
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
      className="flex-1 min-w-0 bg-brand-primary/10 text-neutral-text-primary text-xs px-1 rounded-control
        outline-none ring-1 ring-brand-primary truncate"
      style={{ height: 20 }}
      aria-label={`Rename task ${task.name}`}
    />
  );
}

/**
 * Read-only task name label span plus the note-freshness glyph. Split from
 * TaskNameContent (#2245); markup and aria/title strings verbatim.
 */
function TaskNameLabel(props: TaskNameContentProps) {
  const { task, isCriticalStyle, isSummaryStyle, resourcePool, authoringCandidates } = props;
  return (
    <>
      <span
        className={`min-w-0 shrink truncate ${isCriticalStyle} ${isSummaryStyle}`}
        title={
          (task.isCritical
            ? 'This task is on the critical path — a delay here delays the project end date'
            : `${task.name} — double-click to rename`) +
          // The Gantt bar is canvas-rendered (no DOM bar tooltip), so the
          // notes freshness signal (ADR-0143, issue 740) rides on the row name.
          (task.latestNoteAt
            ? `  ·  last note ${formatRelative(new Date(task.latestNoteAt))}`
            : '')
        }
        aria-label={`${task.wbs} ${task.name}${task.isCritical ? ' (critical path)' : ''}${task.assignees.length > 0 ? ` — assigned to ${task.assignees.map((a) => a.name).join(', ')}` : ''}${task.latestNoteAt ? `, last note ${formatRelative(new Date(task.latestNoteAt))}` : ''}`}
      >
        {/* An `@name` left in the committed name matched nobody on the roster — it is
            underlined rather than hidden so the author can see and correct it
            (ADR-0774 §6). `aria-label` above already carries the plain name, so the
            per-token annotation adds signal without duplicating the row's label. */}
        <UnresolvedTokenName
          name={task.name}
          pool={resourcePool ?? []}
          tasks={authoringCandidates?.tasks}
          phases={authoringCandidates?.phases}
        />
      </span>
      {task.latestNoteAt && (
        <span
          className="inline-flex shrink-0 items-center text-xs text-neutral-text-secondary"
          title={`Last note ${formatRelative(new Date(task.latestNoteAt))}`}
          aria-hidden="true"
          data-testid="note-freshness-chip"
        >
          <NoteIcon className="h-3.5 w-3.5 shrink-0" />
        </span>
      )}
    </>
  );
}

/**
 * At-a-glance external-link status chip (issue 767, ADR-0155): link glyph +
 * count, tinted by the worst link status. Self-guards to null for
 * summary/milestone rows and rows with no live links. Split from
 * TaskNameContent (#2245); markup verbatim.
 */
function ExternalLinkChip({ task }: { task: Task }) {
  const summary = task.externalLinkSummary;
  // Exact negation of the original `!isSummary && !isMilestone && summary && count > 0`.
  if (task.isSummary || task.isMilestone || !summary || !(summary.count > 0)) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 text-xs font-medium ${
        summary.worstStatus
          ? LINK_STATUS_TEXT_CLASS[summary.worstStatus]
          : 'text-neutral-text-secondary'
      }`}
      title={`${summary.count} link${summary.count === 1 ? '' : 's'}${
        summary.worstStatus ? ` · worst status: ${summary.worstStatus}` : ''
      }`}
      aria-label={`${summary.count} external link${summary.count === 1 ? '' : 's'}${
        summary.worstStatus ? `, worst status: ${summary.worstStatus}` : ''
      }`}
      data-testid="link-status-chip"
    >
      <LinkIcon className="w-3 h-3" aria-hidden="true" />
      <span>{summary.count}</span>
    </span>
  );
}

/**
 * Trailing status badges of the name cell: "N planned", missing-dates,
 * the inline recalc-% prompt, and the external-link chip. Split from
 * TaskNameContent (#2245); markup verbatim.
 */
function TaskNameBadges(props: TaskNameContentProps) {
  const {
    task,
    rowMode,
    plannedBadge,
    itl,
    requestRevealGutterSprint,
    hasMissingDatesWarning,
    recalcPrompt,
    updateTask,
    projectId,
    canEdit,
    setRecalcPrompt,
  } = props;
  return (
    <>
      {/* Delivery-mode chip (#2737) — first badge, because it classifies the
          row while the badges after it describe its state. Passive text; the
          gutter carries the same fact non-textually. */}
      <ModeChip mode={rowMode} />
      {/* "N planned" badge (#1798): a phase row whose subtree holds sprint-
          assigned backlog. Muted + dashed neutral (never a semantic/critical
          token) — planned work is a read-state, not a risk. It is a
          navigation control, not a task action: activating it reveals that
          work in the Unscheduled tray (the #1790 VoC "at-a-glance" layer). */}
      {task.isSummary && plannedBadge && plannedBadge.count > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            requestRevealGutterSprint(plannedBadge.primarySprintId);
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-chip border border-dashed border-neutral-border
            px-1.5 py-0.5 text-xs font-normal text-neutral-text-secondary hover:border-brand-primary hover:text-brand-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          title={
            plannedBadge.sprintNames.length === 1
              ? `Planned for ${plannedBadge.sprintNames[0]} — not a committed date`
              : `${plannedBadge.count} tasks planned for upcoming ${itl.lower}s — not committed dates`
          }
          aria-label={`${plannedBadge.count} planned${plannedBadge.sprintNames.length ? `, targeted for ${plannedBadge.sprintNames.join(', ')}` : ''}. Not committed dates. Activate to show in the Unscheduled tray.`}
          data-testid="planned-badge"
        >
          {plannedBadge.count} planned
        </button>
      )}
      {hasMissingDatesWarning && (
        <MissingCommittedStartChip task={task} projectId={projectId} canEdit={canEdit} />
      )}
      {recalcPrompt?.taskId === task.id && (
        <RecalcPercentChip
          prompt={recalcPrompt}
          onAccept={async (percent) => {
            await updateTask.mutateAsync({
              id: task.id,
              projectId,
              percent_complete: percent,
            });
          }}
          onDismiss={() => setRecalcPrompt(null)}
        />
      )}
      <ExternalLinkChip task={task} />
    </>
  );
}

/**
 * Trailing region of the name cell: dependency count chips (in focus mode)
 * or assignee chips, plus the phase-in-waiting ghost affordance. Split from
 * TaskNameContent (#2245); markup verbatim.
 */
function TaskNameTrailing(props: TaskNameContentProps) {
  const { isSelected, depChips, task, phaseInWaiting, onAddPhaseFirstChild } = props;
  return (
    <>
      {/* Dep chips — shown when task is selected in focus mode; replaces
          assignee chips. Passive counters, not buttons: click-to-highlight
          is tracked in issue 1608. */}
      {isSelected && depChips ? (
        <span
          className="flex items-center gap-0.5 flex-shrink-0"
          aria-label={`${depChips.predsCount} predecessors, ${depChips.succsCount} successors`}
        >
          {depChips.predsCount > 0 && (
            <span
              className={`inline-flex items-center px-1 py-px rounded-chip text-xs font-medium ${depChips.predsCritical ? 'bg-semantic-critical-bg text-semantic-critical' : 'bg-neutral-surface-raised text-neutral-text-secondary'}`}
              title={`${depChips.predsCount} predecessor${depChips.predsCount !== 1 ? 's' : ''}`}
            >
              ←{depChips.predsCount}
            </span>
          )}
          {depChips.succsCount > 0 && (
            <span
              className={`inline-flex items-center px-1 py-px rounded-chip text-xs font-medium ${depChips.succsCritical ? 'bg-semantic-critical-bg text-semantic-critical' : 'bg-neutral-surface-raised text-neutral-text-secondary'}`}
              title={`${depChips.succsCount} successor${depChips.succsCount !== 1 ? 's' : ''}`}
            >
              →{depChips.succsCount}
            </span>
          )}
        </span>
      ) : (
        !task.isSummary && !task.isMilestone && <AssigneeChips assignees={task.assignees} />
      )}
      {/* Phase-in-waiting ghost affordance (issue #1754): a "+ Phase" row
          has no structural child yet, so `isPhaseTask` is still false.
          One tap nests a structural child under it — the row becomes a
          real phase and this hint retires (ScheduleView stops passing
          phaseInWaiting once isPhaseTask flips true). */}
      {phaseInWaiting && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAddPhaseFirstChild?.(task.id);
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-chip border border-dashed border-neutral-border
            px-1.5 py-0.5 text-xs text-neutral-text-secondary hover:border-brand-primary hover:text-brand-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          title="This phase has no tasks yet"
          aria-label={`Add first task to ${task.name}`}
          data-testid="phase-in-waiting-hint"
        >
          <span aria-hidden="true">⊕</span>
          <span>Add first task to this phase</span>
        </button>
      )}
    </>
  );
}

/**
 * Name-column content dispatcher: build-mode edit cell, classic inline-edit
 * input, or the read-only label + badges + trailing region. Refactored into
 * per-branch subcomponents (#2245) to keep each function's cognitive complexity
 * within budget; every branch's markup and behavior is verbatim.
 */
function TaskNameContent(props: TaskNameContentProps) {
  const { buildMode, editingColumnName, isEditing, taskNameWidth } = props;
  if (buildMode && editingColumnName) return <TaskNameBuildEditCell {...props} />;
  if (isEditing) return <TaskNameEditInput {...props} />;
  return (
    <div
      className="flex shrink-0 min-w-0 items-center gap-1 overflow-hidden"
      style={{ width: taskNameWidth }}
    >
      <TaskNameLabel {...props} />
      <TaskNameBadges {...props} />
      <TaskNameTrailing {...props} />
    </div>
  );
}

/**
 * Duration cell — build-mode EditableCell (raises the inline "Recalc %?" prompt
 * under the effective confirm policy, ADR-0151) or the static read cell.
 * Extracted from TaskListRowInner verbatim (#2081).
 */
interface TaskDurationCellProps {
  buildMode: BuildMode | null;
  task: Task;
  widthPx: number;
  /** Structural children — how many tasks the Σ rolls up from (#2951). */
  childCount: number;
  editingColumnDuration: boolean;
  projectId: string;
  updateTask: UpdateTaskMutation;
  setRecalcPrompt: React.Dispatch<React.SetStateAction<RecalcPromptState | null>>;
  effectiveDurationPolicy: ReturnType<typeof useEffectiveDurationPolicy>;
  isCoarsePointer: boolean;
}

function TaskDurationCell({
  buildMode,
  task,
  widthPx,
  childCount,
  editingColumnDuration,
  projectId,
  updateTask,
  setRecalcPrompt,
  effectiveDurationPolicy,
  isCoarsePointer,
}: TaskDurationCellProps) {
  // Σ — the value is computed, not yours (#2951, ADR-0844).
  //
  // A container's estimate rolls up from its children and is server-enforced
  // (`phase_estimate_rollup_locked`), so the editable cell below was offering a
  // write the API refuses. Rendering the marker instead is not decoration: no
  // screen in this package should present a control that would set a
  // container's estimate directly, because a control that appears to override a
  // server-enforced rollup is a lie with a spinner.
  if (task.isSummary) {
    const noun = childCount === 1 ? 'task' : 'tasks';
    const rollsUpFrom = `Rolls up from ${childCount} ${noun}. Change a task to change this.`;
    return (
      <div
        role="gridcell"
        aria-label={`Estimate: ${task.duration} days, rolled up from ${childCount} ${noun}. Not editable here.`}
        title={rollsUpFrom}
        className="flex items-center justify-end shrink-0 border-r border-neutral-border/20
          text-right text-neutral-text-secondary tabular-nums pr-2 gap-1"
        style={{ width: widthPx }}
      >
        <span aria-hidden="true" className="text-neutral-text-secondary/70">
          Σ
        </span>
        {task.duration}d
      </div>
    );
  }

  return buildMode && !task.isMilestone ? (
    <EditableCell
      column="duration"
      value={String(task.duration)}
      display={`${task.duration}d`}
      isEditing={editingColumnDuration}
      inputType="duration"
      ariaLabel={`Duration: ${task.duration} days. Press Enter to edit.`}
      className="justify-end shrink-0 border-r border-neutral-border/20 text-right text-neutral-text-secondary tabular-nums pr-2"
      style={{ width: widthPx }}
      onStartEdit={() => {
        buildMode.focus.focusRow(task.id);
        buildMode.focus.enterCellEdit(task.id, 'duration');
      }}
      onCommit={(parsed) => {
        if (typeof parsed === 'number' && projectId) {
          const oldDuration = task.duration;
          const oldPercent = task.progress;
          updateTask.mutate({ id: task.id, projectId, duration: parsed });
          // Under the effective `confirm` policy this raises the inline
          // opt-in; keep/prorate are handled server-side and raise nothing
          // (ADR-0151, issue 1254).
          setRecalcPrompt(
            buildRecalcPrompt({
              taskId: task.id,
              policy: effectiveDurationPolicy,
              oldPercent,
              oldDuration,
              newDuration: parsed,
              suppressed: isCoarsePointer,
            }),
          );
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
      style={{ width: widthPx }}
      role="gridcell"
      aria-label={task.isMilestone ? 'milestone' : `${task.duration} days`}
    >
      {task.isMilestone ? '—' : `${task.duration}d`}
    </div>
  );
}

/**
 * Start-date cell. Milestones in build mode become an editable date point (the
 * MilestoneDatePopover quick-pick, #345); everything else is a static read
 * cell. Extracted from TaskListRowInner verbatim (#2081).
 */
interface TaskStartCellProps {
  buildMode: BuildMode | null;
  task: Task;
  widthPx: number;
  showMilestonePicker: boolean;
  setShowMilestonePicker: React.Dispatch<React.SetStateAction<boolean>>;
  milestoneParents: Props['milestoneParents'];
  projectId: string;
  updateTask: UpdateTaskMutation;
}

function TaskStartCell({
  buildMode,
  task,
  widthPx,
  showMilestonePicker,
  setShowMilestonePicker,
  milestoneParents,
  projectId,
  updateTask,
}: TaskStartCellProps) {
  const startEntry = useReconcileEntry(task.id, 'start');
  const workingDaysMask = useWorkingDaysMask();
  // A build-mode milestone's Start cell is the click/keyboard target for the
  // date popover; every other row renders a static, non-interactive cell.
  // Hoisted once so the five call sites below stay flat (#2245).
  const isMilestoneEditable = Boolean(buildMode && task.isMilestone);
  const toggleMilestonePicker = () => setShowMilestonePicker((v) => !v);
  return (
    <div
      className={[
        'relative flex items-center justify-end shrink-0 border-r border-neutral-border/20',
        'text-right text-neutral-text-secondary tabular-nums pr-2',
        isMilestoneEditable ? 'cursor-pointer hover:text-neutral-text-primary' : '',
      ].join(' ')}
      style={{ width: widthPx }}
      role="gridcell"
      // The visible cell is ~74px and cannot carry the full `old → new` claim,
      // so the accessible name is the only place a screen-reader user gets it
      // (ADR-0784). Italic — the sighted preview signal — is likewise invisible
      // to assistive tech, hence "pending confirmation" here.
      aria-label={cellAriaLabel('start', task.start, startEntry)}
      title={startEntry?.status === 'diverged' ? describeDivergence(startEntry, workingDaysMask) : undefined}
      tabIndex={isMilestoneEditable ? 0 : undefined}
      onClick={
        isMilestoneEditable
          ? (e) => {
              e.stopPropagation();
              toggleMilestonePicker();
            }
          : undefined
      }
      onKeyDown={
        isMilestoneEditable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleMilestonePicker();
              }
            }
          : undefined
      }
    >
      <DateCellValue value={task.start} entry={startEntry} widthPx={widthPx} />
      {isMilestoneEditable && (
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
  );
}

/**
 * Finish-date cell. Milestones render an em-dash (single-point gate; the date
 * is shown in the Start column). Extracted from TaskListRowInner verbatim (#2081).
 */
function TaskFinishCell({ task, widthPx }: { task: Task; widthPx: number }) {
  const finishEntry = useReconcileEntry(task.id, 'finish');
  const workingDaysMask = useWorkingDaysMask();
  // A milestone has no finish cell content to reconcile — the marker would have
  // nowhere to render and the date it describes lives in the Start column.
  const entry = task.isMilestone ? undefined : finishEntry;
  return (
    <div
      className="flex items-center justify-end shrink-0 border-r border-neutral-border/20
        text-right text-neutral-text-secondary tabular-nums pr-2"
      style={{ width: widthPx }}
      role="gridcell"
      aria-label={
        task.isMilestone
          ? 'milestone — single date in Start column'
          : cellAriaLabel('finish', task.finish, entry)
      }
      title={entry?.status === 'diverged' ? describeDivergence(entry, workingDaysMask) : undefined}
    >
      {/* Milestones are single-point gates: render an em-dash so the row
          never displays a date range that contradicts the diamond marker.
          The single date is shown in the Start column. */}
      {task.isMilestone ? (
        '—'
      ) : (
        <DateCellValue value={task.finish} entry={entry} widthPx={widthPx} />
      )}
    </div>
  );
}

/**
 * Progress cell. Non-milestone build-mode rows use the editable percent cell
 * (with structured 400 error handling for progress-anchor / rollup-lock);
 * everything else delegates to MilestoneProgressCell. Extracted from
 * TaskListRowInner verbatim (#2081).
 */
interface TaskProgressCellProps {
  buildMode: BuildMode | null;
  task: Task;
  widthPx: number;
  editingColumnProgress: boolean;
  projectId: string;
  updateTask: UpdateTaskMutation;
  setScheduleError: (message: string | null) => void;
  itl: IterationLabel;
  /** #2639: gates a percent-complete write behind a confirmation naming the
   *  target status when it would trigger the server's silent REVIEW/COMPLETE
   *  auto-promotion; commits immediately otherwise. */
  requestProgressCommit: ProgressAutoStatusConfirm['requestCommit'];
}

function TaskProgressCell({
  buildMode,
  task,
  widthPx,
  editingColumnProgress,
  projectId,
  updateTask,
  setScheduleError,
  itl,
  requestProgressCommit,
}: TaskProgressCellProps) {
  return buildMode && !task.isMilestone ? (
    <EditableCell
      column="progress"
      value={String(task.progress)}
      display={`${Math.round(task.progress)}%`}
      isEditing={editingColumnProgress}
      inputType="number"
      ariaLabel={`Progress: ${Math.round(task.progress)}%. Press Enter to edit.`}
      className="justify-end shrink-0 text-right text-neutral-text-secondary tabular-nums pr-2"
      style={{ width: widthPx }}
      onStartEdit={() => {
        buildMode.focus.focusRow(task.id);
        buildMode.focus.enterCellEdit(task.id, 'progress');
      }}
      onCommit={(parsed) => {
        if (typeof parsed === 'number' && projectId) {
          requestProgressCommit(task.status, parsed, () => {
            updateTask.mutate(
              { id: task.id, projectId, percent_complete: parsed },
              {
                onError: (err) => {
                  if (parseProgressAnchorError(err)) {
                    setScheduleError(
                      `Set a Planned Start date (or assign a ${itl.lower}) before recording progress.`,
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
          });
        }
        buildMode.focus.commitToRow();
      }}
      onRollback={() => buildMode.focus.rollbackToRow()}
      onTabForward={() => buildMode.focus.tabForward()}
      onTabBackward={() => buildMode.focus.tabBackward()}
    />
  ) : (
    <MilestoneProgressCell task={task} widthPx={widthPx} />
  );
}

/**
 * Owner cell. Summary tasks render an empty cell (assignees roll up implicitly).
 * Extracted from TaskListRowInner verbatim (#2081).
 */
function TaskOwnerCell({ task, widthPx }: { task: Task; widthPx: number }) {
  return (
    <div
      className="flex items-center shrink-0 pl-2"
      style={{ width: widthPx }}
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
  );
}

/**
 * Sprint-assignment region shown after a name commit in agile build mode (#346).
 * Renders the SprintPrompt, or — when the commit trips a Tier-1 warn or an
 * Owner-escalated Tier-2 block (ADR-0101) — the corresponding outcome panel
 * anchored to the same position. Extracted from TaskListRowInner verbatim (#2081).
 */
interface SprintAssignmentRegionProps {
  buildMode: BuildMode | null;
  showSprintPrompt: boolean;
  sprintOutcome: SprintOutcome | null;
  setSprintOutcome: React.Dispatch<React.SetStateAction<SprintOutcome | null>>;
  setShowSprintPrompt: React.Dispatch<React.SetStateAction<boolean>>;
  projectId: string;
  task: Task;
  updateTask: UpdateTaskMutation;
}

function SprintAssignmentRegion({
  buildMode,
  showSprintPrompt,
  sprintOutcome,
  setSprintOutcome,
  setShowSprintPrompt,
  projectId,
  task,
  updateTask,
}: SprintAssignmentRegionProps) {
  return (
    <>
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
    </>
  );
}
