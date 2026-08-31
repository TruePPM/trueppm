import { renameRowLabel } from './rowVocabulary';
import type { DependencyDirection } from './deps/linkTypes';
import { memo, useState, useRef, useCallback, useEffect } from 'react';
import { formatChord } from '@/lib/platform';
import type React from 'react';
import { useProjectId } from '@/hooks/useProjectId';
import { useIsCoarsePointer } from '@/hooks/useIsCoarsePointer';
import { useEffectiveDurationPolicy, useProjectHoursPerDay } from '@/hooks/useProject';
import { RecalcPercentChip } from './RecalcPercentChip';
import { buildRecalcPrompt, type RecalcPromptState } from './recalcPercentPrompt';
import {
  useProgressAutoStatusConfirm,
  type ProgressAutoStatusConfirm,
} from './useProgressAutoStatusConfirm';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import type { ProjectResource, Task } from '@/types';
import {
  INSERT_DISC_SIZE,
  WBS_INDENT,
  resolveInsertLaneGap,
  resolveInsertTapSize,
} from './scheduleConstants';
import { formatContainmentCount } from './containmentCount';
import { useRowMetrics } from '@/hooks/useRowHeight';
import { Tooltip } from '@/components/Tooltip';
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
import { AssigneeChips, formatOwnerCellLabel } from './AssigneeChips';
import {
  depFlag,
  describeLinksCell,
  type DepFlag,
  type TaskDepChips,
} from './deps/depFlag';

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
import { canEditTaskRow, canAuthorDependencies } from '@/lib/roles';
import {
  DepthGuides,
  PhaseBandEdge,
  PHASE_BAND_NAME_CLASS,
  PHASE_BAND_ROW_CLASS,
} from './RowContainmentChrome';
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
import { MILESTONE_REFUSES_SUMMARY } from './trail/structuralActs';
import {
  ROW_VOCABULARY,
  ROW_NOUN,
  ROW_NOUN_PLURAL,
  insertBelowRowLabel,
  addFirstRowToLabel,
  ADD_FIRST_ROW_TO_PHASE,
} from './rowVocabulary';

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
   * This row's incoming and outgoing edges — what the Links cell states (#3023).
   *
   * Was a pair of counts rendered beside the task name, and only while the row
   * was selected in focus mode. It now carries the edges (types + lag) because
   * the flag names the types, and it renders in its own column at rest.
   */
  depChips?: TaskDepChips;
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
  onAddDependencyRequest?: (taskId: string, direction?: DependencyDirection) => void;
  /** Existing sibling names at the row's WBS-parent level — used to suffix "(copy)". */
  siblingNames?: string[];
  /** Source sprint snapshot used by the Undo affordance. Null when not in a sprint. */
  sourceSprint?: { id: string; name: string; state: string } | null;
  /**
   * True when this row was created via "+ Phase" (issue #1754) and has no
   * structural child yet — renders the ghost "Add first item to this phase"
   * affordance in place of the assignee chips. Never true once the row has a
   * structural child (it is then a real phase, per `isPhaseTask`).
   */
  phaseInWaiting?: boolean;
  /** Creates the phase's first structural child (issue #1754). */
  onAddPhaseFirstChild?: (taskId: string) => void;
  /**
   * True for exactly one row (the one just created via "+ Phase" or its
   * ghost "add first item" affordance, issue #1754) when Build Mode is not
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
  /**
   * Begin a pointer drag from this row's ⋮⋮ grip (#2954). Supplied by
   * `TaskListPanel`, which owns the session — the row can start a gesture but
   * cannot resolve one, since it does not know what is under the pointer.
   *
   * Absent is a real state: a row rendered outside the panel (tests, storybook)
   * still shows its grip, because grip *presence* tracks edit rights (rule 302)
   * and nothing else.
   */
  onOutlineDragStart?: (taskId: string, e: React.PointerEvent) => void;
  /** This row is the one currently being dragged (#2954). */
  isDragSource?: boolean;
  /** Open the "Move to…" destination picker for this row (#2954). */
  onMoveToRequest?: (taskId: string) => void;
  /**
   * Width of the ⋮⋮ grip's lane (#2997) — from `TaskListPanel`, which is the
   * only place that can answer it consistently for the header and every row.
   * Defaults to 0: a row rendered outside the panel has no grip lane, and a
   * viewer's panel passes 0 so nobody gives up 44px of name column to a control
   * web rule 302 keeps absent.
   */
  gripReserve?: number;
  /**
   * Width of the ⇤/⇥ structural-nudge lane (#3026) — from `TaskListPanel`, for
   * the same reason `gripReserve` is: the header, every row, the pending rows
   * and the draft row must reserve the *same* number or the columns do not line
   * up. Defaults to 0, which is also what a viewer's panel passes.
   */
  nudgeReserve?: number;
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
  /** `buildMode` when the reader may author, else `null` (rule 302, #2961). */
  authoring: BuildMode | null;
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
  const { buildMode, authoring, anyCellInEdit, task } = ctx;
  if (!buildMode || anyCellInEdit) return;
  // Reorder and indent/outdent restructure the plan; selection and focus
  // traversal read it. A viewer keeps the second set and loses the first
  // (web rule 302, #2961) — silently, since nothing on the row advertised them.
  if (authoring && tryBuildModeReorder(e, ctx)) return;
  if (authoring && tryBuildModeIndent(e, ctx)) return;
  if (tryBuildModeSelectAll(e, ctx)) return;
  if (tryBuildModeSelectExtend(e, ctx)) return;
  if (tryBuildModeFocusMove(e, ctx)) return;
  // Plain Tab/Shift-Tab is deliberately NOT intercepted here — see
  // tryBuildModeIndent's doc comment. It falls through to native browser
  // focus traversal, same as everywhere else on the page.
  // Letter key (single printable, not modified) opens Name cell-edit
  // pre-filled with the typed letter — but we keep it simple in v1 and
  // just enter cell-edit; the user re-types if they want to overwrite.
  if (
    authoring &&
    e.key.length === 1 &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    /[a-zA-Z0-9]/.test(e.key)
  ) {
    e.preventDefault();
    authoring.focus.enterCellEdit(task.id, 'name');
    return;
  }
  // Delete (Backspace/Delete) on focused row — destructive, no confirm, to
  // keep the build path fast. The safety net is the "Deleted — Undo" toast
  // wired into buildMode.deleteTask (ScheduleView, #1762): Undo recreates the
  // task from a pre-delete snapshot. The same path backs the ⋮ menu's Delete.
  if (authoring && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    // Structural keys apply to every selected row when a multi-row selection
    // is active (#2727, ADR-0776 §1).
    const selectedIds = authoring.focus.state.selectedIds;
    if (selectedIds && selectedIds.size > 1) {
      selectedIds.forEach((id) => authoring.deleteTask(id));
    } else {
      authoring.deleteTask(task.id);
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
  /** `buildMode` when the reader may author, else `null` (rule 302, #2961). */
  authoring: BuildMode | null;
  /** Whether this reader may mutate — true on the flag-off path too (#2961). */
  canEdit: boolean;
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
  const { authoring: buildMode, task, isSelected, setSelectedTaskId } = ctx;
  if (buildMode) {
    // Shift+Enter = sibling above, ⌘/Ctrl+Enter = child, plain Enter = sibling
    // below (#2727). The modifiers are explicit insert gestures and ignore the
    // `enterCreatesRow` preference; only the plain chord is a "finish the edit"
    // motion that a renamer wants without a new row (#3079).
    if (e.metaKey || e.ctrlKey) buildMode.insertChild(task.id);
    else if (e.shiftKey) buildMode.insertAbove(task.id);
    else if (buildMode.enterCreatesRow !== false) buildMode.insertBelow(task.id);
    // Preference off: keep the one mental model this file states — "Enter always
    // ends with the cursor in an editable Name cell" — by opening the editor on
    // THIS row instead of a new one, which is what F2 already does.
    else buildMode.focus.enterCellEdit(task.id, 'name');
  } else {
    setSelectedTaskId(isSelected ? null : task.id);
  }
}

/**
 * F2 on a focused row: enter the Name cell edit in build mode, or the classic
 * inline rename otherwise. Split from handleRowKeyDown (#2245); semantics verbatim.
 */
function handleRowF2(ctx: RowKeyDownCtx): void {
  const { authoring: buildMode, task, startEdit } = ctx;
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
  const { handleToggleComplete, handleDuplicate, canEdit } = ctx;
  if (tryRowArrowSelect(e, ctx)) return;
  // Everything past this point writes — mark-complete, duplicate, insert,
  // rename. Without edit rights the row offers none of them, so the keys do
  // nothing rather than explaining a refusal nobody invited (rule 302, #2961).
  // Enter is the exception below: for a viewer it still selects the row, which
  // is what it does on the flag-off path and is navigation, not mutation.
  //
  // Gated on `canEdit`, not on `authoring`: the latter is also null for an
  // editor who is simply not in build mode, and this reducer IS that editor's
  // only path to Space / ⌘D / F2.
  if (!canEdit) {
    if (e.key === 'Enter') {
      e.preventDefault();
      ctx.setSelectedTaskId(ctx.isSelected ? null : ctx.task.id);
    }
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
  // Alt+Enter opens the task detail drawer (#2979). Handled ahead of the
  // build-mode reducer, like Home/End above, because the act is identical in
  // both modes and neither reducer claims it.
  //
  // It has to be Alt+Enter rather than something more obvious, and the reasons
  // are all taken: plain `Enter` inserts a row in build mode, `Shift`/`⌘`+Enter
  // insert above/child, `F2` renames, and a bare letter starts typing into the
  // Name cell — so no unmodified key is free. Alt+Enter is the platform's own
  // "show me the details of this thing" binding, which is the meaning wanted.
  //
  // Not gated on edit rights: opening a task is a read. `setSelectedTaskId`
  // rather than the `isSelected ? null : id` toggle the plain-Enter path uses —
  // Open means open, and toggling would make the button and the key disagree.
  if (e.key === 'Enter' && e.altKey && !isEditing && !anyCellInEdit) {
    e.preventDefault();
    ctx.setSelectedTaskId(ctx.task.id);
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
  onAddDependencyRequest: ((taskId: string, direction?: DependencyDirection) => void) | undefined;
  handleToggleComplete: () => void;
  handleDuplicate: () => void;
  onClassifyRequest: Props['onClassifyRequest'];
  onMoveToRequest: Props['onMoveToRequest'];
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
    onMoveToRequest,
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
      hint: formatChord('alt+ArrowRight'),
      startsGroup: true,
      disabled: level <= 1,
      onSelect: () => buildMode.indent(task.id),
    },
    {
      key: 'outdent',
      label: 'Outdent',
      icon: <OutdentIcon className="h-4 w-4" aria-hidden="true" />,
      hint: formatChord('alt+ArrowLeft'),
      // Disable outdent at root level (level 1).
      disabled: level <= 1,
      onSelect: () => buildMode.outdent(task.id),
    },
    {
      // #2954. Drag can move a row to an *arbitrary* parent; ⌥→/⌥← can only
      // step one level against the row above. Without this the drag would be
      // the sole route to a capability, which fails WCAG 2.1.1 — and on touch
      // it is the route that needs no drag at all.
      key: 'move-to',
      label: 'Move to…',
      icon: <IndentIcon className="h-4 w-4" aria-hidden="true" />,
      disabled: !onMoveToRequest,
      onSelect: () => onMoveToRequest?.(task.id),
    },
    {
      // One item, not two (#3113). Direction is a field inside the dialog now,
      // so picking the wrong menu entry no longer costs a close-and-reopen with
      // the search retyped — and the choice is visible where it is made.
      key: 'add-dependency',
      label: 'Add dependency…',
      icon: <ArrowDownLeftIcon className="h-4 w-4" aria-hidden="true" />,
      startsGroup: true,
      disabled: !onAddDependencyRequest,
      onSelect: () => onAddDependencyRequest?.(task.id),
    },
    {
      key: 'duplicate',
      label: 'Duplicate',
      icon: <CopyIcon className="h-4 w-4" aria-hidden="true" />,
      hint: formatChord('mod+d'),
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
      hint: formatChord('mod+shift+m'),
      startsGroup: true,
      disabled: !onClassifyRequest,
      onSelect: () => onClassifyRequest?.(task.id),
    },
    {
      // A reversible toggle, not a one-way command (#3256). It was disabled only
      // when the row was ALREADY a milestone, which made the act unrepeatable in
      // the one direction that mattered and left a phase offering a conversion it
      // could never perform.
      key: 'milestone',
      label: task.isMilestone ? 'Milestone' : 'Convert to milestone',
      icon: <MilestoneIcon className="h-4 w-4" aria-hidden="true" />,
      checked: task.isMilestone,
      disabled: task.isSummary,
      disabledReason: task.isSummary ? MILESTONE_REFUSES_SUMMARY : undefined,
      onSelect: () =>
        task.isMilestone
          ? buildMode.convertToTask(task.id)
          : buildMode.convertToMilestone(task.id),
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
  isPhaseRow: boolean;
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
    // The phase band's wash. Listed BEFORE selectionClass so hover and
    // selection still win on top of it — a selected phase must read as
    // selected first (#2956).
    s.isPhaseRow ? PHASE_BAND_ROW_CLASS : '',
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

/**
 * One direction's flag, rendered as its own control when the reader may author.
 *
 * Its own control, not a share of one: a cell that draws `←FS×2` and `→FS`
 * side by side and routes both to the predecessor picker sends half the clicks
 * to the wrong direction, and the two chips look like two targets because they
 * are two facts.
 *
 * Criticality is carried by weight and an inset ring as well as by hue — the red
 * tint alone is a WCAG 1.4.1 failure, and `depFlag` also puts it in words so it
 * reaches the tooltip and the cell's label.
 */
function DepFlagChip({
  flag,
  direction,
  isCritical,
  onOpen,
  tabIndex,
}: {
  flag: DepFlag;
  direction: 'predecessor' | 'successor';
  isCritical: boolean;
  onOpen: (() => void) | undefined;
  tabIndex?: number;
}) {
  const tone = isCritical
    ? 'bg-semantic-critical-bg text-semantic-critical font-semibold ring-1 ring-inset ring-semantic-critical'
    : 'bg-neutral-surface-raised text-neutral-text-secondary font-medium';
  const className = `inline-flex min-w-0 max-w-full items-center truncate rounded-chip px-1 py-px text-xs tabular-nums ${tone}`;
  const body = (
    <>
      {direction === 'predecessor' ? '←' : '→'}
      {flag.label}
    </>
  );

  if (!onOpen) {
    return (
      <span className={className} title={flag.detail} data-testid={`dep-flag-${direction}`}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      // The accessible NAME stays constant while the row's links change, so the
      // control does not rename itself as the plan is edited; the state is in
      // the tooltip and the cell's own label (rule 316).
      aria-label={`Edit ${direction} links`}
      title={flag.detail}
      tabIndex={tabIndex}
      data-testid="links-cell-control"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className={`${className} border border-transparent hover:border-brand-primary hover:text-brand-primary
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary`}
    >
      <span data-testid={`dep-flag-${direction}`} className="truncate">
        {body}
      </span>
    </button>
  );
}

/**
 * The Links cell (#3023, `design_handoff_trueppm_v4/README.md`).
 *
 * Two things the shipped row could not do at once. It **states** the row's
 * dependency shape — `←FS×2` reads as a chain, `←FS·SS` as an overlap — and it
 * **offers to change it**, in the same place, in one gesture. Before this the
 * only entry point was a right-click menu, so the row could show its links or
 * offer to edit them but never both; and the count chips it did show rendered
 * only while the row was selected in focus mode, which means the outline did not
 * carry its own dependency state at rest and could not be scanned down.
 *
 * The flag renders **unconditionally** — selection, focus mode and hover are all
 * irrelevant to it. That is the whole point: a planner glancing down the column
 * is looking for the row that is linked, and a signal that appears only after
 * you have already found the row answers a question you no longer have.
 *
 * Entitlement (web rule 302): with no authoring rights the cell is **text, not a
 * field** — same content, no button, nothing to press and be refused. The gate
 * is `authoring` (edit rights AND an outline that authors), never `buildMode`,
 * which is also non-null for a viewer because it carries row navigation.
 *
 * Each direction opens its own direction in the picker. A row with **no** links
 * gets one control, on the predecessor direction, because that is the question a
 * links cell is asked — what governs this row's start; a first successor is
 * still added from the row menu, which this does not replace.
 *
 * `focus-visible:` rather than `focus:` on the controls is deliberate: they sit
 * in a roving-tabindex treegrid (`tabIndex` is -1 on every non-active row), so
 * the ring only ever appears on a keyboard traversal, which is the case the
 * variant exists for and what every sibling row control already uses.
 */
function TaskLinksCell({
  task,
  widthPx,
  depChips,
  onOpenLinkPicker,
  tabIndex,
}: {
  task: Task;
  widthPx: number;
  depChips: Props['depChips'];
  onOpenLinkPicker: ((direction: DependencyDirection) => void) | undefined;
  tabIndex?: number;
}) {
  const predsCritical = depChips?.predsCritical ?? false;
  const succsCritical = depChips?.succsCritical ?? false;
  // Derived ONCE and passed down. Each flag carries its own detail string, and
  // deriving them again inside each chip built and threw away a second copy on
  // every row of a virtualized list.
  const pred = depFlag(depChips?.preds ?? [], 'predecessor', predsCritical);
  const succ = depFlag(depChips?.succs ?? [], 'successor', succsCritical);
  const description = describeLinksCell(pred, succ, task.name);
  const addLabel = `Add a dependency link to ${task.name}`;

  return (
    <div
      role="gridcell"
      className="flex items-stretch shrink-0 overflow-hidden"
      style={{ width: widthPx }}
      aria-label={description}
      data-testid="links-cell"
    >
      {!pred && !succ ? (
        // Empty state. The control fills the cell rather than sitting as an
        // ~18px dash inside it, so the target is the 44px row on a coarse
        // pointer and the whole cell is the "add a link here" affordance.
        onOpenLinkPicker ? (
          <button
            type="button"
            aria-label={addLabel}
            title={addLabel}
            tabIndex={tabIndex}
            data-testid="links-cell-control"
            onClick={(e) => {
              e.stopPropagation();
              onOpenLinkPicker('predecessor');
            }}
            className="flex h-full w-full items-center pl-2 text-xs text-neutral-text-disabled
              hover:text-brand-primary focus-visible:outline-none focus-visible:ring-2
              focus-visible:ring-inset focus-visible:ring-brand-primary"
          >
            —
          </button>
        ) : (
          <span className="flex h-full w-full items-center pl-2 text-xs text-neutral-text-disabled">
            —
          </span>
        )
      ) : (
        <span className="flex h-full min-w-0 items-center gap-0.5 overflow-hidden pl-2">
          {pred && (
            <DepFlagChip
              flag={pred}
              direction="predecessor"
              isCritical={predsCritical}
              onOpen={onOpenLinkPicker ? () => onOpenLinkPicker('predecessor') : undefined}
              tabIndex={tabIndex}
            />
          )}
          {succ && (
            <DepFlagChip
              flag={succ}
              direction="successor"
              isCritical={succsCritical}
              onOpen={onOpenLinkPicker ? () => onOpenLinkPicker('successor') : undefined}
              tabIndex={tabIndex}
            />
          )}
        </span>
      )}
    </div>
  );
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
  /** Link graph for this row — what the Links cell states (#3023). */
  depChips: Props['depChips'];
  /**
   * Present only for a reader who may author. `undefined` makes the Links cell
   * text rather than a control (web rule 302) — a viewer must find the picker
   * absent, not disabled.
   */
  onOpenLinkPicker: ((direction: DependencyDirection) => void) | undefined;
  /**
   * Roving tab stop (0 on the active row, -1 elsewhere). Without it every row's
   * Links button becomes its own tab stop and Tab walks a 1000-row plan.
   */
  rovingChildTabIndex: number;
}

/**
 * The Links / Dur / Start / Finish / Progress / Owner columns. Each is suppressed while
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
  depChips,
  onOpenLinkPicker,
  rovingChildTabIndex,
}: TaskDataCellsProps) {
  return (
    <>
      {/* ── Links column (#3023) ────────────────────────────────────────────── */}
      {!isEditing && visible.links && (
        <TaskLinksCell
          task={task}
          widthPx={widths.links}
          depChips={depChips}
          onOpenLinkPicker={onOpenLinkPicker}
          tabIndex={rovingChildTabIndex}
        />
      )}

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
 * The ⋮⋮ grip (#347, extended to reorder-or-reparent in #2954) — revealed on row
 * hover or focus-within, always visible on touch, and **absent** without edit
 * rights (web rule 302: no rights means no apparatus, not a dimmed one).
 *
 * The grip only *starts* the gesture; the session lives in `TaskListPanel`,
 * which is the only thing that can answer "what row is under the pointer now".
 * Nothing here calls a mutation, and the drop model — sibling vs child, and the
 * two refusals — lives in `outlineDrag.ts` where it can be tested without a
 * pointer.
 *
 * `aria-hidden`, and deliberately so. Everything this gesture does has a
 * keyboard twin that is already announced (`⌥↑`/`⌥↓` reorder, `⌥→`/`⌥←`
 * indent/outdent, and the row menu's "Move to…" for an arbitrary destination),
 * so exposing a grip a keyboard user cannot operate would add a tab stop per row
 * — a 40-row outline's worth — that leads nowhere. The `title` is the pointer
 * user's hint and names the keyboard twin next to it.
 *
 * Sizing follows the **pointer class, not the viewport width** (#2997). It used
 * to be `max-md:w-[26px]`, which is a breakpoint: a 1024px tablet — a coarse
 * pointer with a wide screen — got the 14px mouse grip, and a narrow desktop
 * window got the fat one. `useRowMetrics()` asks the question the target size
 * actually depends on.
 *
 * On a coarse pointer the grip is **44 x 44**: 44 wide from `gripWidth`, and 44
 * tall from `rowHeight` — an explicit height, not `inset-y-0`, for the reason
 * the inline comment on the style prop gives (a stretched child stops at the
 * row's `border-b` and measures 43). #2954
 * shipped it at 26x28 with the mitigation that a taller grip would reach into
 * its neighbours' grips inside a 28px row — that constraint is gone, not
 * loosened, and the width is reserved (`gripReserve`) rather than laid over the
 * WBS column's nudges, so nothing else loses a target to pay for this one.
 * A mouse still sees 14px and gives up no row width at all.
 */
function RowReorderHandle({
  taskId,
  taskName,
  onDragStart,
  isDragging,
  gripWidth,
  rowHeight,
  coarse,
}: {
  taskId: string;
  taskName: string;
  onDragStart?: (taskId: string, e: React.PointerEvent) => void;
  isDragging: boolean;
  gripWidth: number;
  rowHeight: number;
  coarse: boolean;
}) {
  return (
    <div
      data-testid="row-reorder-grip"
      data-dragging={isDragging ? 'true' : undefined}
      // `top: 0` + an explicit height rather than `inset-y-0`: the row's own
      // `border-b` is inside its border-box, so an inset-stretched child is
      // `rowHeight - 1` tall — 43px, and a 43px target has not met a 44px floor
      // however close it looks. Spanning the border line costs nothing (the
      // neighbour's grip starts exactly where this one ends, never over it).
      style={{ width: gripWidth, height: rowHeight }}
      className={[
        'absolute left-0 top-0 z-10 flex items-center justify-center',
        coarse
          ? 'opacity-100'
          : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
        'transition-opacity cursor-grab active:cursor-grabbing',
        // The browser's own pan/select gestures would fight the drag on touch.
        'touch-none select-none',
        isDragging
          ? 'opacity-100 text-brand-primary'
          : // `neutral-text-disabled` is 2.66:1 and reserved for inert
            // affordances (web rule 169); it is only acceptable here because a
            // mouse lifts it to `secondary` on hover. There is no hover on a
            // coarse pointer, so the resting state IS the state — 2.66:1 would
            // sit permanently under WCAG 1.4.11's 3:1 on the row's flagship
            // control (#2997).
            coarse
            ? 'text-neutral-text-secondary'
            : 'text-neutral-text-disabled hover:text-neutral-text-secondary',
      ].join(' ')}
      title={`Drag to reorder or reparent ${taskName || 'this row'}  ·  ${REORDER_KEY}+↑/↓, ${REORDER_KEY}+←/→ keyboard`}
      aria-hidden="true"
      onPointerDown={(e) => onDragStart?.(taskId, e)}
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
 * Split a rendered WBS path into its ancestor prefix and its leaf segment.
 *
 * Operates on the **already-truncated** string, not the raw path: the leaf the
 * reader can see is the one worth emphasising, and `truncateWbsPath` guarantees
 * the leaf survives the middle ellipsis. Splitting the raw path first and
 * truncating the halves separately would re-open the case the truncation exists
 * to close.
 *
 * A depth-1 path (`"3"`) has no ancestors, so the prefix is empty.
 *
 * The ellipsis counts as a separator, and that is the point of splitting on
 * `.` OR `…` rather than on `.` alone: in `"1.…2"` the ellipsis *stands in for*
 * the elided ancestor segments, so it belongs to the prefix. Splitting on the
 * dot alone would hand the leaf span `"…2"` and emphasise a mark that is not
 * this row's number.
 *
 * `truncateWbsPath`'s two-segment branch can also put the ellipsis last
 * (`"10.…"`), leaving no visible leaf digit at all. That yields an empty leaf,
 * which renders nothing — correct, because there is no own-number to emphasise.
 */
export function splitWbsLeaf(rendered: string): { ancestors: string; leaf: string } {
  const cut = Math.max(rendered.lastIndexOf('.'), rendered.lastIndexOf('…'));
  if (cut === -1) return { ancestors: '', leaf: rendered };
  return { ancestors: rendered.slice(0, cut + 1), leaf: rendered.slice(cut + 1) };
}

/**
 * WBS column (#248, realigned #3055).
 *
 * ## Why this is left-aligned, and why that is the whole depth cue
 *
 * It was right-aligned, which flushed `1`, `2`, `2.1` and `3` to a common right
 * edge and made `2.1` read as a peer of `3` rather than as something inside `2`.
 * That is a **numeric** convention — quantities align on their last digit so
 * magnitudes stack — applied to an **identifier**. A WBS path is an address: its
 * leading segments name the parent, and those are what must line up with the
 * parent's row.
 *
 * In `tppm-mono` every segment is a fixed advance, so the ladder is already in
 * the string for free: `2` → `2.1` → `2.1.4` self-indents two characters per
 * level. Right-alignment was precisely what threw that away.
 *
 * So there is deliberately **no `paddingLeft: (level - 1) * step` here.** The
 * string is the ladder; a padding ladder on top of it compounds, and at depth 4+
 * in a resizable column it pushes the leaf into the very ellipsis
 * `truncateWbsPath` exists to prevent. It would also run at a different rhythm
 * from the name cell's `WBS_INDENT` (16px vs a ~7px mono advance) — two ladders
 * that disagree. `DepthGuides` remains the sole carrier of the drawn-rule
 * channel; a tree glyph in here would make neither authoritative.
 *
 * ## The leaf is emphasised UP, never the ancestors down
 *
 * The conventional treatment fades the ancestor segments. We raise the leaf
 * instead, and that is an accessibility constraint rather than a preference:
 * there is no `--neutral-text-tertiary` token, and the only weaker one
 * (`--neutral-text-disabled`, ≈2.5:1 on surface) would fail WCAG 1.4.3 for a
 * low-vision **sighted** reader. The cell's `aria-label` does not rescue that —
 * 1.4.3 governs visual text, and an accessible name is a different channel.
 * Both spans therefore stay at or above 4.5:1, and the leaf is found by contrast
 * instead of by position — which is what replaces the predictable leaf x that
 * right-alignment used to buy.
 *
 * ## `aria-label` and `title` carry the FULL path and must not change
 *
 * The visible string is truncated; the accessible name never is. Roughly twenty
 * e2e specs locate rows by `WBS <path>`, and the two spans below sit inside one
 * wrapper whose `textContent` is still the rendered path, so a text query keeps
 * matching a single element.
 */
function RowWbsCell({ wbs, widthPx }: { wbs: string; widthPx: number }) {
  // −2 chars, not −1: the cell now pads on BOTH sides (pl-2 + pr-1), where it
  // used to pad only on the right. The 8px divisor is the mono advance at
  // text-xs, unchanged from #248.
  const rendered = truncateWbsPath(wbs, Math.max(3, Math.floor(widthPx / 8) - 2));
  const { ancestors, leaf } = splitWbsLeaf(rendered);
  return (
    <div
      className="flex items-center justify-start shrink-0 border-r border-neutral-border/20
        text-left text-neutral-text-secondary tppm-mono pl-2 pr-1 text-xs"
      style={{ width: widthPx }}
      role="gridcell"
      aria-label={`WBS ${wbs}`}
      title={wbs}
    >
      <span className="truncate">
        {ancestors}
        <span className="text-neutral-text-primary font-medium">{leaf}</span>
      </span>
    </div>
  );
}

/**
 * The structural-nudge lane — ⇤ outdent / ⇥ indent, in a lane of their own
 * (#3026).
 *
 * ## Why this is not inside `RowWbsCell` any more
 *
 * It was, and that made the pair conditional on `visible.wbs` — a Display ▸
 * Columns preference. Hiding the WBS column deleted indent and outdent from
 * every row and left the right-click menu as the only pointer route, which is
 * exactly the discoverability problem the design placed them at the WBS number
 * to solve. The lane is now reserved by `TaskListPanel` and rendered here
 * whenever that reserve is non-zero, so a column choice cannot delete a control.
 *
 * The lane sits immediately left of where the WBS column draws, so when that
 * column *is* shown the pair is still adjacent to the number that states the
 * depth it changes — and it stays at the row's left edge, far from delete. The
 * design is explicit that a structural nudge and a destructive act must not be
 * neighbours (#2956), so this is never fixed by moving the pair rightward.
 *
 * ## The 32% resting opacity is load-bearing — do not regress it
 *
 * `opacity-[0.32]` with **only `opacity`** transitioning is what reserves the
 * space: the buttons occupy their box at rest, so hovering the row brightens
 * them in place instead of inserting them and shoving the FS/CP chips sideways
 * under the pointer. `opacity-0 group-hover:opacity-100` looks identical in a
 * screenshot and reintroduces the layout shift. Because the pair now has its own
 * fixed-width lane the reservation is doubly true, but the opacity treatment
 * stays: it is also what keeps the resting row calm.
 *
 * The reveal is keyed on the **row's** group, not the lane's. A `group/nudge`
 * scoped to a 34px lane means the pointer has to already be on the control to
 * see it — which is the discoverability problem restated, and it is not what the
 * neighbouring affordances do (the grip and the insert `+` both read the row's
 * unnamed `group`).
 *
 * ## …and it does not apply on a coarse pointer
 *
 * There is no hover on a finger, and both buttons are `tabIndex={-1}`, so
 * neither `group-hover` nor `focus-within` can ever fire on touch: 32% would be
 * the *resting and only* state. `neutral-text-secondary` at 0.32 over the row's
 * surface is ≈1.6:1 — well under WCAG 1.4.11's 3:1 for an active control, and a
 * 44px target nobody can see
 * is not a discoverable one, and sizing it without showing it would have fixed
 * the measurable half of #3026 and left the half that matters. This is the same
 * branch `RowReorderHandle` and the insert `+` already carry, for the same
 * reason.
 *
 * ## Sizing
 *
 * `size` comes from `useRowMetrics()` → `resolveNudgeSize`, whose coarse value
 * *is* `ROW_HEIGHT_COARSE`. There is no second `44` here and no `md:` breakpoint
 * (web rule 315): a 1024px tablet is a coarse pointer with a wide screen, and a
 * narrow desktop window is not a finger. The buttons were hard-coded `w-4 h-4`,
 * so they stayed 16px inside the 44px row #2997 shipped — on the surface whose
 * stated reason to exist is that restructuring must not be keyboard-only, for
 * the user who has no keyboard.
 *
 * The lane is `self-start` with an explicit `rowHeight`, and each button takes
 * the full `size`: the row's own `border-b` is inside its border box, so a
 * centered or `inset-y-0` child measures `rowHeight - 1` — 43px, which has not
 * met a 44px floor however close it looks (the #2997 corollary).
 */
function RowStructureNudges({
  laneWidth,
  size,
  rowHeight,
  coarse,
  onIndent,
  onOutdent,
  canOutdent,
  taskName,
}: {
  laneWidth: number;
  size: number;
  rowHeight: number;
  coarse: boolean;
  onIndent?: () => void;
  onOutdent?: () => void;
  canOutdent: boolean;
  taskName: string;
}) {
  const showControls = onIndent != null || onOutdent != null;
  const buttonClass = `flex items-center justify-center rounded-control text-neutral-text-secondary
    hover:text-brand-primary
    focus:outline-none focus:ring-1 focus:ring-inset focus:ring-brand-primary`;
  return (
    <div
      // A populated lane is a real cell: `role="row"` in a treegrid may own only
      // gridcell/columnheader/rowheader, and these buttons used to be inside the
      // WBS `gridcell`. Freeing them from that column must not cost the row its
      // ARIA structure. When empty the lane is `aria-hidden` instead — its width
      // is what keeps a viewer's rows column-aligned with an editor's and with
      // the header, but an empty presentational box must not join the row's
      // gridcell set (#2204).
      role={showControls ? 'gridcell' : undefined}
      aria-label={showControls ? 'Restructure' : undefined}
      aria-hidden={showControls ? undefined : true}
      data-testid="row-structure-nudges"
      className="flex shrink-0 items-center justify-center self-start gap-0.5"
      style={{ width: laneWidth, height: rowHeight }}
    >
      {showControls && (
        // Always rendered, at 32% opacity on a mouse, so the space is reserved
        // and nothing shifts under the pointer on hover. Only `opacity`
        // transitions — see the docstring; this is why the FS/CP chips no longer
        // swap out. Full strength on a coarse pointer, where the resting state
        // IS the state.
        <span
          data-testid="row-structure-nudges-ink"
          className={[
            'flex items-center gap-0.5 transition-opacity',
            coarse
              ? 'opacity-100'
              : 'opacity-[0.32] focus-within:opacity-100 group-hover:opacity-100',
          ].join(' ')}
        >
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
            title={`Outdent (${formatChord('alt+ArrowLeft')})`}
            style={{ width: size, height: size }}
            className={`${buttonClass} disabled:opacity-40 disabled:cursor-not-allowed`}
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
            title={`Indent (${formatChord('alt+ArrowRight')})`}
            style={{ width: size, height: size }}
            className={buttonClass}
          >
            ⇥
          </button>
        </span>
      )}
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
  // One derivation of the phrase, shared with the visible chip and the live
  // region (#3025) — see `containmentCount.ts`.
  const containment = formatContainmentCount(childCount, isExpanded);
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
        containment
          ? isExpanded
            ? `Collapse ${task.name}, ${containment}`
            : `Expand ${task.name}, ${containment}`
          : isExpanded
            ? `Collapse ${task.name}`
            : `Expand ${task.name}`
      }
      // No `title`: the count is drawn on the row now (`RowContainmentCount`),
      // so a tooltip here would be a second copy of a fact already on screen —
      // and it was the *only* copy, which is the defect (#3025).
      title={undefined}
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
 * The row's containment statement — `4 inside` open, `4 hidden` shut (#3025).
 *
 * The design asks the row to *state* its child count, and what shipped stated it
 * only in a `title` and an `aria-label`: a sighted user had to hover the caret
 * and wait out the tooltip delay to learn how many rows were inside a phase, or
 * whether a collapsed phase held anything at all. A tooltip is not a scan, and
 * on touch there is no hover to perform — on the surface #2997 just made a
 * first-class touch target.
 *
 * Three properties, all deliberate:
 *
 * - **`aria-hidden`.** The caret's accessible name already carries the same
 *   phrase from the same function, and the caret is the control this describes.
 *   Announcing it twice per row would make a 40-row plan read as 80 facts. This
 *   is the rule-309(b) treatment: a redundant *encoding* of something ARIA
 *   already says, which is also why it may sit at a muted weight.
 * - **`shrink-0`, beside a `shrink truncate` name.** Containment outranks the
 *   tail of a long name for the width: the name degrades to an ellipsis, the
 *   count stays legible. A count that silently truncates to `4 insi` would be
 *   the tooltip problem again in a different costume.
 * - **No hover or fold branch on visibility.** It is present at rest, in both
 *   fold states — the acceptance criterion of the issue and the whole point.
 */
function RowContainmentCount({
  childCount,
  isExpanded,
}: {
  childCount: number;
  isExpanded: boolean;
}) {
  const containment = formatContainmentCount(childCount, isExpanded);
  if (!containment) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center whitespace-nowrap text-xs text-neutral-text-secondary"
      aria-hidden="true"
      data-testid="containment-count"
    >
      {containment}
    </span>
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
  /** The outline's navigation model — row focus, selection. Present for a viewer. */
  buildMode: BuildMode | null;
  /**
   * The outline's authoring API — the same object, or `null` without edit
   * rights (web rule 302, #2961). Every mutation site reads this; every
   * navigation site reads `buildMode`.
   */
  authoring: BuildMode | null;
  /**
   * Whether this reader may mutate at all. Distinct from `authoring`, which is
   * also null on the flag-off (non-build-mode) path — conflating the two takes
   * the classic inline rename away from an editor who simply is not in build
   * mode (#2961).
   */
  canEdit: boolean;
  /**
   * May this reader author dependency EDGES? (#3142)
   *
   * A third band, not a synonym for either flag above. Edges are
   * `IsProjectScheduler`; task content is `IsProjectPlanAuthor`; neither
   * contains the other (ADR-0773 §7). `canEdit` is therefore false for the
   * whole Scheduler band, which is exactly the band that MAY author edges —
   * so gating the dependency affordances on `authoring` refused a Scheduler
   * the server accepts, and offered a Member a 403.
   */
  canAuthorDeps: boolean;
  task: Task;
  isSelected: boolean;
  setSelectedTaskId: (id: string | null) => void;
  startEdit: () => void;
  setMenuAnchor: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  onHoverChange?: (taskId: string | null) => void;
  /** Every visible row id, top to bottom — the order a shift-click range slices. */
  visibleTaskIds?: string[];
}

/**
 * Shift-click extends the selection; a plain click collapses it (#2955).
 *
 * The third selection gesture the design names, beside `⇧↑ ⇧↓` and `⌘A`, and the one a
 * pointer user reaches for. It routes through the **same** `extendSelection` reducer
 * action as Shift+↑/↓ rather than computing a range here: the anchor semantics (fixed
 * for the life of the selection, unlike `rowId` which tracks the moving edge) are the
 * whole subtlety, and a second implementation of them would diverge on the case that
 * matters — shift-clicking back *inside* an existing range has to shrink it, not
 * restart it.
 *
 * `buildMode`, not `authoring`: selecting rows is navigation. A viewer may still build
 * a range and read across it; what they may not do is act on one, and the acts are
 * absent for them (rule 302 / #2961).
 */
function handleRowClick(e: React.MouseEvent, ctx: RowSurfaceCtx): void {
  if (ctx.isEditing || ctx.anyCellInEdit) return;
  if (ctx.buildMode) {
    if (e.shiftKey && ctx.visibleTaskIds && ctx.buildMode.focus.state.rowId) {
      // Suppress the native text selection a shift-click drags across the row.
      e.preventDefault();
      ctx.buildMode.focus.extendSelection(ctx.task.id, ctx.visibleTaskIds);
      return;
    }
    ctx.buildMode.focus.focusRow(ctx.task.id);
  } else {
    ctx.setSelectedTaskId(ctx.isSelected ? null : ctx.task.id);
  }
}

function handleRowDoubleClick(ctx: RowSurfaceCtx): void {
  // Silent, per web rule 302: without edit rights nothing on this row offers a
  // rename, so there is no gesture left to explain (#2961).
  if (!ctx.canEdit) return;
  if (ctx.authoring) {
    // Build-mode double-click → enter Name cell (consistent across all editable cells).
    ctx.authoring.focus.focusRow(ctx.task.id);
    ctx.authoring.focus.enterCellEdit(ctx.task.id, 'name');
  } else {
    ctx.startEdit();
  }
}

function handleRowContextMenu(e: React.MouseEvent, ctx: RowSurfaceCtx): void {
  // The menu opens if EITHER band has something in it (#3142). It used to test
  // `authoring` alone, which is null for the whole Scheduler band — so the one
  // role that may author dependencies got the native browser menu instead of
  // the row menu carrying `Add dependency…`, on the surface where they do their
  // work. A reader with neither band still gets the native menu rather than an
  // empty one (#2961).
  const nav = ctx.buildMode;
  if (!nav) return;
  if (!ctx.authoring && !ctx.canAuthorDeps) return;
  // #806: suppress right-click while a structural mutation (indent/outdent/
  // delete) is in flight for this row. Opening the menu mid-delete strands
  // the BuildModeRowMenu portal when the row unmounts on cache invalidation,
  // which then blocks subsequent right-clicks on other rows until refresh.
  //
  // Read off `buildMode`, not `authoring`: it is the same object when both are
  // present, and it is the one that survives the Scheduler case.
  if (nav.isMutationPending(ctx.task.id)) return;
  e.preventDefault();
  nav.focus.focusRow(ctx.task.id);
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
  canAuthorDeps: boolean,
  ctx: Omit<RowMenuCtx, 'buildMode'>,
): RowMenuItem[] {
  // A Scheduler has no task-content authoring and therefore no `buildMode`
  // here, but MAY author edges — so the menu is not all-or-nothing any more
  // (#3142). Build the dependency item on its own band and the rest on
  // task-content authoring; a reader with neither gets `[]` and
  // `handleRowContextMenu` never opens the menu.
  const contentItems = buildMode ? buildRowMenuItems({ ...ctx, buildMode }) : [];

  // Role decides PRESENCE; the handler decides DISABLED. They are different
  // questions and folding them together loses the second: "no picker host to
  // open into" is a wiring state that has always rendered as a disabled item,
  // and it must keep doing so for a reader who holds the band.
  if (contentItems.length > 0) {
    return canAuthorDeps ? contentItems : contentItems.filter((i) => i.key !== 'add-dependency');
  }

  // A dependency-ONLY menu is the exception: a lone disabled item is a menu
  // with nothing to do in it, so here the missing handler suppresses the menu
  // rather than dimming its only entry.
  if (!canAuthorDeps || ctx.onAddDependencyRequest === undefined) return [];

  // Dependency-only menu. `startsGroup` is dropped: it draws a separator above
  // the item, which reads as "the group before this one was suppressed" when it
  // is the first and only entry.
  return [
    {
      key: 'add-dependency',
      label: 'Add dependency…',
      icon: <ArrowDownLeftIcon className="h-4 w-4" aria-hidden="true" />,
      onSelect: () => ctx.onAddDependencyRequest?.(ctx.task.id),
    },
  ];
}

/**
 * Critical-path and summary emphasis for the task-name cell. Split out of
 * TaskListRowInner (#2081); both class strings are verbatim.
 */
function taskNameStyles(
  task: Task,
  isPhaseRow: boolean,
): { isCriticalStyle: string; isSummaryStyle: string } {
  return {
    isCriticalStyle: task.isCritical
      ? 'font-semibold text-semantic-critical'
      : 'text-neutral-text-primary',
    // A phase gets the display face (#2956); a leaf-with-subtasks is `isSummary`
    // but NOT a phase (ADR-0293) and keeps the plain weight it always had.
    isSummaryStyle: isPhaseRow ? PHASE_BAND_NAME_CLASS : task.isSummary ? 'font-medium' : '',
  };
}

/**
 * Is this row a phase — a container of structural work (ADR-0293)?
 *
 * Mirrors `isPhaseTask()` without needing the whole task list: prefer what the
 * author **declared**, then the server's derived verdict, then fall back to
 * "has a structural child" using the tree flags the row already receives.
 * `isSummary` is deliberately not enough — it is also true for a leaf whose only
 * children are drawer subtasks, and banding those would say "container" about a
 * row that contains no work.
 *
 * ## Why `structureRole` is consulted FIRST (#3056)
 *
 * ADR-0293 keeps phase-ness *emergent*, and that is still right: MS Project, P6
 * and every WBS tool derive summary-ness from having children, and asking an
 * author to both declare a phase and nest work under it makes them state one
 * fact twice — after which the two drift. Nothing here adds a stored phase type;
 * ADR-0058 rejected `task_type` and this needs no such thing.
 *
 * But #2950 added the one declaration the *rendering* half genuinely needs.
 * `Task.structure_role` is documented — in its own `help_text` and in the
 * `Task` type — as governing rendering, grouping and vocabulary and never
 * computation, and `models.py` is explicit that a **declared** container which
 * loses its last child "stays declared and becomes an empty lane" rather than
 * being silently demoted back to work. The server holds that line. Until this
 * function read the field, the outline then contradicted it on screen: the row
 * lost its band, its edge and its display face and rendered as ordinary work,
 * with only a trailing ghost affordance dissenting.
 *
 * The derived verdict still wins every *computation* — this function feeds only
 * presentation (the row wash, the name face, and `PhaseBandEdge`), gates no
 * write, and so cannot lock a row the server would accept a PATCH on. An empty
 * declared container stays fully editable, which is exactly what
 * `structure_role`'s "presentation only" contract promises.
 *
 * An empty declared container gets no fold caret, and that falls out rather than
 * being special-cased: `hasChildren` is computed independently, so "N inside"
 * never appears on a row with nothing in it.
 */
function isPhaseRowOf(task: Task, hasChildren: boolean): boolean {
  if (task.isSubtask) return false;
  if (task.structureRole === 'container') return true;
  if (typeof task.isPhase === 'boolean') return task.isPhase;
  return hasChildren;
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
  onOutlineDragStart,
  isDragSource = false,
  onMoveToRequest,
  gripReserve = 0,
  nudgeReserve = 0,
}: Props) {
  // Row geometry follows the pointer class (#2997): 28px rows on a mouse, 44px
  // and a 44x44 grip in its own lane on a coarse pointer. `nudgeSize` is the
  // same question asked for the ⇤/⇥ pair (#3026) — one subscription, so the row
  // cannot pick up a height from one render and a target size from another.
  const { rowHeight, gripWidth, nudgeSize, coarse } = useRowMetrics();
  const projectId = useProjectId() ?? '';
  const itl = useIterationLabel(projectId);
  const selectedTaskId = useScheduleStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
  const requestRevealGutterSprint = useScheduleStore((s) => s.requestRevealGutterSprint);
  const setScheduleError = useScheduleStore((s) => s.setScheduleError);
  const setScheduleActionToast = useScheduleStore((s) => s.setScheduleActionToast);
  const isSelected = selectedTaskId === task.id;
  const updateTask = useUpdateTask();
  const {
    role: currentRole,
    isLoading: roleLoading,
    isError: roleError,
  } = useCurrentUserRole(projectId || undefined);
  // Same UX gate the drawer sections use — server capability first, role
  // fallback. Gates the remediation actions in the "no committed start" chip
  // popover (web-rules 156/272) and, since #2961, the row's whole authoring
  // apparatus.
  //
  // Presence follows the *settled* entitlement. While the role is unresolved we
  // assume rights, and that direction is deliberate: the server is the
  // enforcement point (rule 302), so briefly offering a control to someone who
  // turns out to be a viewer costs at worst one silent refusal — whereas
  // briefly hiding it from an editor is a layout shift on every schedule load
  // and a row that grows controls a second after it appeared. An unresolved
  // role is not "no rights"; treating unknown as denial *is* the flicker.
  //
  // A FAILED lookup is unresolved too, and that is the case worth naming: the
  // hook retries nothing, so before #2961 an error was indistinguishable from
  // "settled: not a member", and one dropped request would have stripped an
  // editor's whole apparatus with no error state anywhere to explain it.
  //
  // `task.canEdit` still wins outright when the server sent it, because that is
  // a settled answer and does not depend on the role query at all.
  const roleUnsettled = roleLoading || roleError === true;
  const canEdit = canEditTaskRow(task.canEdit, currentRole, roleUnsettled);
  /**
   * The dependency-edge band (#3142) — Scheduler and above, resolved
   * independently of `canEdit`.
   *
   * `roleUnsettled` is OR'd in for the same reason `canEditTaskRow` folds it:
   * `useCurrentUserRole` sets `retry: false`, so one dropped request is
   * terminal and indistinguishable from "not a member". Assume rights on an
   * unknown — the server is the enforcement point, so the cost is at worst one
   * silent refusal, against permanently removing a working control.
   */
  const canAuthorDeps = roleUnsettled || canAuthorDependencies(currentRole);

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
  // Web rule 302 applied to the row (#2961). `buildMode` is two things wearing
  // one name: the outline's NAVIGATION model (row focus, arrow traversal,
  // selection, the roving tab stop) and its AUTHORING API (insert, indent,
  // reorder, delete, cell edit). A reader with no edit rights keeps the first
  // and must not be offered the second — so every mutation site below reads
  // `authoring` and every navigation site keeps reading `buildMode`.
  //
  // Nulling `buildMode` wholesale would have been one line, and wrong: it takes
  // the arrow keys, ⌘A, Shift+↑/↓ and the roving tab stop with it, leaving a
  // viewer a grid they cannot move around in. Absence is meant to remove what
  // authors the plan, not what reads it.
  const authoring: BuildMode | null = canEdit ? buildMode : null;
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
      authoring,
      anyCellInEdit,
      siblingIds,
      visibleTaskIds,
      task,
      prevTaskId,
      nextTaskId,
      reorderTasks,
      focusRowDom,
    });

  const { handleToggleComplete, handleDuplicate } = useRowActions({
    projectId,
    task,
    buildMode: authoring,
    toggleComplete,
    duplicateTask,
    updateTask,
    siblingNames,
    sourceSprint,
    setScheduleError,
    setScheduleActionToast,
  });

  const isComplete = task.status === 'COMPLETE';
  // A viewer gets an empty list and `handleRowContextMenu` never opens it
  // (#2961). "Every item mutates" is still true, but they no longer mutate on
  // ONE band: the dependency item rides `canAuthorDeps` (#3142).
  const menuItems: RowMenuItem[] = buildRowMenuItemsFor(authoring, canAuthorDeps, {
    task,
    level,
    isComplete,
    onAddDependencyRequest,
    handleToggleComplete,
    handleDuplicate,
    onClassifyRequest,
    onMoveToRequest,
  });

  const isPhaseRow = isPhaseRowOf(task, hasChildren);
  const { isCriticalStyle, isSummaryStyle } = taskNameStyles(task, isPhaseRow);

  /**
   * Width of the ⇤/⇥ lane on THIS row (#3026) — **whatever the panel reserved,
   * and nothing else.**
   *
   * There is deliberately no `authoring` fallback here, and the reason is worth
   * stating because the fallback looks obviously right. The lane is an *in-flow*
   * box, so its width is layout: if a row renders one the panel did not reserve,
   * every column on that row sits a lane right of its own heading and the
   * content overruns the panel's fixed-width box — the #2960 failure, which has
   * no symptom other than misalignment.
   *
   * And the two gates genuinely differ. The panel asks `onMoveRow !== undefined`,
   * which `ScheduleView` derives from `readOnly = !hasEditRights || authorMode
   * === 'read'`; the row asks `canEdit ? buildMode : null`, where `canEdit` is
   * the server's per-task flag and `BuildModeProvider` is mounted for any
   * non-mobile viewport. Flip the Read/Author pill to **Read** and the panel
   * reserves nothing while every row still wants a lane. A per-row gate can
   * never be reconciled with a panel-level number anyway — `canEdit` varies row
   * to row — which is exactly why the grip is absolutely positioned and this
   * lane is the panel's to own.
   *
   * The consequence is intentional: in Read mode the pair is absent. That is the
   * mode's whole promise, and `onMoveRow` being undefined there means a
   * structural move could not commit in any case.
   */
  const nudgeLane = nudgeReserve;

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
    authoring,
    canEdit,
    canAuthorDeps,
    task,
    isSelected,
    setSelectedTaskId,
    startEdit,
    setMenuAnchor,
    onHoverChange,
    visibleTaskIds,
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
      style={{ height: rowHeight }}
      className={getRowClassName({
        isEditing,
        anyCellInEdit,
        buildMode,
        isBuildSelected,
        isSelected,
        isHovered,
        dimmed,
        isStructuralPending,
        isPhaseRow,
      })}
      onClick={(e) => handleRowClick(e, surface)}
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
          authoring,
          canEdit,
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

      {/* ── ⋮⋮ grip — drag to reorder or reparent (#347, #2954) ─────────────── */}
      {/* Grip absent, not disabled, without edit rights — web rule 302 (#2961). */}
      {authoring && (
        <RowReorderHandle
          taskId={task.id}
          taskName={task.name}
          onDragStart={onOutlineDragStart}
          isDragging={isDragSource}
          gripWidth={gripWidth}
          rowHeight={rowHeight}
          coarse={coarse}
        />
      )}

      {/* The grip's lane (#2997). A spacer rather than row padding, because the
          grip is `absolute left-0` and would move with the padding — see
          `resolveGripReserve`. Rendered whenever the reserve is non-zero, with
          or without edit rights, so a viewer's rows stay column-aligned with an
          editor's and with the header. */}
      {gripReserve > 0 && (
        <span aria-hidden="true" className="shrink-0" style={{ width: gripReserve }} />
      )}

      {/* ── WBS column (#248) ───────────────────────────────────────────────── */}
      {/* Insert-below affordance (#2957). On the row's BOTTOM EDGE, because that
          is where the new row will appear — the single "Add item" button at the
          foot of the list did the cursor's bidding from somewhere its position
          did not imply, which reads as a bug.

          Out of the tab order on purpose: a tab stop per row would make a
          40-row outline unnavigable. Its keyboard twin is `⏎`, which already
          inserts a sibling below the focused row and is what the coach bar and
          the cheatsheet teach — so this is a pointer affordance for an operation
          the keyboard already has, not a pointer-only capability. It still
          carries `focus:opacity-100` so programmatic focus reveals it. */}
      {authoring && (
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            authoring.insertBelow(task.id);
          }}
          aria-label={insertBelowRowLabel(task.name)}
          title={ROW_VOCABULARY.create.insertHereTitle}
          className={[
            'absolute left-0 bottom-0 translate-y-1/2 z-10',
            'flex items-center justify-center rounded-full',
            'border border-neutral-border bg-neutral-surface-raised',
            'text-xs leading-none text-neutral-text-secondary',
            // Hover-revealed on a mouse; permanently visible on a coarse
            // pointer, where there is no hover to reveal it with. Without this
            // branch the affordance is invisible AND out of the tab order on a
            // tablet, so build mode's "insert a sibling here" has no pointer
            // path at all on the device 44px rows exist for (#2997).
            coarse ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
            'hover:text-brand-primary hover:border-brand-primary',
            'focus:outline-none focus:ring-2 focus:ring-brand-primary',
            'transition-opacity',
            // The 16px disc is the mark; the tappable box around it is the
            // target. `before:` rather than a bigger button so the disc keeps
            // its position between rows and the row's own layout does not move.
            //
            // SIZED and centered, not inset — rule 315's own corollary, and the
            // two pixels no unit test could see. `before:-inset-3.5` resolves
            // against the button's PADDING box, and the disc's 1px border sits
            // inside its 16px border box, so the box measured 42 and this control
            // was under the touch floor for its whole life while every vitest
            // assertion agreed it was fine (jsdom renders no pseudo geometry at
            // all). An explicit edge length is immune to the border.
            //
            // The size reads a CSS variable rather than a literal because it IS
            // `ROW_HEIGHT_COARSE` and a Tailwind class is a static string —
            // writing 44 here would be a second declaration of the touch floor,
            // frozen at authoring time, which is the module-scope capture web
            // rule 315(b) forbids (#3029). Coarse-only: on a mouse the disc is
            // hover-revealed, so a 44px box would be an unseen target over the
            // row's rename cell.
            coarse
              ? [
                  'before:absolute before:content-[""]',
                  'before:left-1/2 before:top-1/2',
                  'before:-translate-x-1/2 before:-translate-y-1/2',
                  'before:w-[var(--insert-tap-size)] before:h-[var(--insert-tap-size)]',
                ].join(' ')
              : '',
          ].join(' ')}
          // Past BOTH left-edge lanes, and past what the TAP BOX overhangs
          // (#3026). The `+` is `absolute left-0`, so its offset names every
          // lane ahead of it by hand and a lane added later is invisible to it.
          // Two separate mistakes are available here and the second is the
          // subtle one: omit the nudge term and the disc lands inside the ⇤/⇥
          // lane; include it but clear only the disc, and the `before:` box —
          // which is what the browser actually hit-tests — still covers the
          // indent button's bottom-right 10px. `resolveInsertLaneGap` owns
          // both, so the gap is the one on a mouse (no `before:` box is drawn)
          // and the one plus the overhang on a finger.
          //
          // The disc is sized here rather than by `w-4 h-4` so it and the tap
          // box come from one place: `INSERT_DISC_SIZE` is what
          // `INSERT_TAP_INSET_COARSE` is derived against, so the two cannot
          // drift into a box that is no longer centered on its mark.
          style={
            {
              marginLeft:
                gripReserve + nudgeLane + resolveInsertLaneGap(coarse) + (level - 1) * 12,
              width: INSERT_DISC_SIZE,
              height: INSERT_DISC_SIZE,
              // Resolved for THIS pointer class, and emitted on both so the
              // value is inspectable — on a mouse it is the disc's own size, so
              // the variable states "the tap box is the mark" rather than
              // carrying a 44 the surface has decided not to use. Only the
              // coarse-only `before:` class above reads it.
              '--insert-tap-size': `${resolveInsertTapSize(coarse)}px`,
            } as React.CSSProperties
          }
        >
          +
        </button>
      )}

      {/* ── Structural-nudge lane (#3026) ───────────────────────────────────
          Its OWN lane, deliberately not inside the WBS cell: that cell is
          conditional on a Display ▸ Columns preference, so nesting the pair in
          it meant turning off an unrelated column deleted indent and outdent
          from every row. Rendered whenever the reserve is non-zero — with or
          without edit rights — so a viewer's rows stay column-aligned with an
          editor's and with the header, exactly like the grip's lane above. */}
      {nudgeLane > 0 && (
        <RowStructureNudges
          laneWidth={nudgeLane}
          size={nudgeSize}
          rowHeight={rowHeight}
          coarse={coarse}
          taskName={task.name}
          canOutdent={level > 1}
          // Absent, not disabled, without edit rights — web rule 302 (#2949).
          onIndent={authoring ? () => authoring.indent(task.id) : undefined}
          onOutdent={authoring ? () => authoring.outdent(task.id) : undefined}
        />
      )}

      {visible.wbs && <RowWbsCell wbs={task.wbs} widthPx={widths.wbs} />}

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
        {/* Containment chrome (#2956) — one vertical rule per ancestor level,
            and, on a phase, its own sage edge at the indent origin those rules
            run on. Both are aria-hidden redundant encodings of what
            `aria-level`, the WBS number and the fold caret's `N inside` count
            already say; both are siblings of the cell content and
            pointer-events-none, never wrappers (the #2782 class). */}
        <DepthGuides level={level} />
        {isPhaseRow && <PhaseBandEdge level={level} />}

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
          // `authoring`: the cell primitives branch on this to decide field vs
          // text, so a viewer reads a plan rather than a form someone locked.
          buildMode={authoring}
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
          phaseInWaiting={phaseInWaiting}
          onAddPhaseFirstChild={onAddPhaseFirstChild}
          childCount={childCount}
          isExpanded={isExpanded}
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
        buildMode={authoring}
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
        depChips={depChips}
        // `canAuthorDeps`, not `authoring` (#3142): this chip opens the
        // dependency picker, so it answers to the EDGE band. Gating it on
        // task-content authoring made a viewer's Links cell text — correct —
        // and a Scheduler's Links cell text too, which is not: they are the
        // role the server accepts here (web rule 302, #3023, ADR-0773 §7).
        // `onAddDependencyRequest` being absent means the picker has no host to
        // open into, which is also text — not a dead button.
        onOpenLinkPicker={
          canAuthorDeps && onAddDependencyRequest
            ? (direction) => onAddDependencyRequest(task.id, direction)
            : undefined
        }
        rovingChildTabIndex={rovingChildTabIndex}
      />
      {progressAutoStatusDialog}
      {/* Sprint assignment prompt after name commit in agile mode (#346).
          When the commit trips a Tier-1 warn or an Owner-escalated Tier-2 block
          (ADR-0101), the prompt is replaced by the corresponding outcome panel
          anchored to the same position rather than closing silently. */}
      <SprintAssignmentRegion
        buildMode={authoring}
        showSprintPrompt={showSprintPrompt}
        sprintOutcome={sprintOutcome}
        setSprintOutcome={setSprintOutcome}
        setShowSprintPrompt={setShowSprintPrompt}
        projectId={projectId}
        task={task}
        updateTask={updateTask}
      />
      {menuItems.length > 0 && menuAnchor && (
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
        // Testid alongside the sibling lock icon's (#3256): the chip is aria-hidden,
        // and its text is a bare "0d"/"-2d" that a row-wide `getByText(/\dd/)` now
        // collides with, since the Dur cell states a milestone's zero rather than
        // dashing it. Scope the assertion instead of relying on the em-dash.
        <span
          className={`tppm-mono text-xs ${varianceClass}`}
          aria-hidden="true"
          data-testid="milestone-rollup-variance"
        >
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
  phaseInWaiting: boolean;
  onAddPhaseFirstChild: Props['onAddPhaseFirstChild'];
  /** Structural children, and whether they are showing — the `N inside` /
   *  `N hidden` statement the row draws beside the name (#3025). */
  childCount: number;
  isExpanded: boolean;
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
  // The `#Nh` token converts through the project calendar, not a fixed 8h day
  // (#3042). Shares the cached project query, so this costs no extra fetch per row.
  const hoursPerDay = useProjectHoursPerDay(projectId);
  const suggestionContext = {
    pool,
    tasks: authoringCandidates?.tasks ?? [],
    phases: authoringCandidates?.phases ?? [],
    hoursPerDay,
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
        ariaLabel={renameRowLabel(task.name)}
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
          // #3079: with the preference off, a plain Enter commits and stops. The
          // edit is already committed by EditableCell before this fires, so doing
          // nothing here IS "commit without creating" — the reported case.
          else if (buildMode.enterCreatesRow !== false) buildMode.insertBelow(task.id);
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
      aria-label={renameRowLabel(task.name)}
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
    childCount,
    isExpanded,
  } = props;
  return (
    <>
      {/* Delivery-mode chip (#2737) — first badge, because it classifies the
          row while the badges after it describe its state. Passive text; the
          gutter carries the same fact non-textually. */}
      <ModeChip mode={rowMode} />
      {/* `4 inside` / `4 hidden` (#3025) — second, for the same reason the mode
          chip is first: both classify the row, and everything after them
          describes its state. */}
      <RowContainmentCount childCount={childCount} isExpanded={isExpanded} />
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
 * Trailing region of the name cell: assignee chips plus the phase-in-waiting
 * ghost affordance. Split from TaskNameContent (#2245).
 *
 * The dependency chips that used to live here moved to the Links cell (#3023).
 * They were a pair of counts (`←2` / `→1`) that rendered only while the row was
 * selected in focus mode, which meant the row did not carry its own dependency
 * state at rest — you had to select a row to learn whether it had links, which
 * defeats scanning. They also displaced the assignee chips whenever they
 * appeared, so selecting a row swapped out an unrelated fact.
 */
function TaskNameTrailing(props: TaskNameContentProps) {
  const { task, phaseInWaiting, onAddPhaseFirstChild } = props;
  return (
    <>
      {!task.isSummary && !task.isMilestone && <AssigneeChips assignees={task.assignees} />}
      <OpenTaskButton task={task} />
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
          // `shrink min-w-0`, not `shrink-0` (#3057). The name label is the only
          // other shrinkable item in this fixed-width cell, so a `shrink-0` hint
          // 181px wide took the whole cell and squeezed the name to zero — a row
          // that says "I am a phase" and will not say *which* phase. Yielding
          // degrades this to the glyph plus clipped text; `title`/`aria-label`
          // still carry the full string, so nothing is lost to AT.
          className="inline-flex shrink min-w-0 items-center gap-1 rounded-chip border border-dashed border-neutral-border
            px-1.5 py-0.5 text-xs text-neutral-text-secondary hover:border-brand-primary hover:text-brand-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          title={ROW_VOCABULARY.create.phaseHasNoRows}
          aria-label={addFirstRowToLabel(task.name)}
          data-testid="phase-in-waiting-hint"
        >
          <span aria-hidden="true" className="shrink-0">
            ⊕
          </span>
          <span className="truncate">{ADD_FIRST_ROW_TO_PHASE}</span>
        </button>
      )}
    </>
  );
}

/**
 * The row's Open affordance (#2979).
 *
 * Before this there was no way to open a task from the schedule at all unless
 * you were a *reader without edit rights* (for whom `Enter` on a focused row
 * opens the drawer) or you found the canvas bar's double-click. An editor in
 * build mode had neither: `Enter` inserts a row for them, and the Grid surface
 * has no bar to double-click. The row menu was not the answer — it is gated on
 * `authoring`, so it is empty for exactly the readers who most need a way in.
 *
 * So this is deliberately **not** gated on edit rights. Opening a task is a
 * read, and the one affordance has to serve both surfaces and every role, or it
 * reintroduces the split it exists to close.
 *
 * Why a button rather than making the name itself clickable: the name cell is an
 * *edit* target — it takes inline rename, `F2`, and the name-autocomplete
 * popover. Putting a second interaction model on it would fight the thing that
 * cell already does, which is the drift #2960 removed. A distinct control has no
 * gesture to lose an argument with, and it brings focus, `Tab`, and a real
 * accessible name along with it.
 *
 * `aria-label` carries the task name because the accessible name is computed
 * from *trimmed* text nodes — an icon-only button would otherwise announce as
 * "button" with nothing to distinguish it from the thirty others on screen.
 */
function OpenTaskButton({ task }: { task: Task }) {
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
  const { coarse } = useRowMetrics();
  return (
    // Rule 287: an icon-only control's explanation must reach hover, keyboard
    // focus AND touch, which is why this is the shared `Tooltip` and not a bare
    // `title` — `title` is invisible to keyboard focus and unreachable on touch.
    // `describe={false}` because the sentence restates the button's own
    // accessible name; wiring `aria-describedby` to a duplicate of the name is a
    // double announcement (rule 287c).
    <Tooltip content="Open details" describe={false}>
      <button
        type="button"
        // The row owns the roving tab stop, so this is reached by arrowing to the
        // row and pressing Alt+Enter rather than by Tab — see `handleRowKeyDown`.
        // Left in the a11y tree (never `display:none`) so a screen reader finds it
        // on the row it belongs to; only its opacity is animated.
        onClick={(e) => {
          // The row's own click handler selects/toggles — opening is a different
          // intent and must not also move the selection out from under the drawer.
          e.stopPropagation();
          setSelectedTaskId(task.id);
        }}
        className={[
          'relative inline-flex shrink-0 items-center justify-center rounded-control p-0.5',
          'text-neutral-text-secondary transition-opacity hover:text-brand-primary',
          // A `group-hover` reveal never fires on a touch device (rule 287a), so
          // on a coarse pointer the resting state IS the state — same treatment
          // the ⋮⋮ grip and the insert affordances already take in this file.
          // `focus:opacity-100` as well as `group-focus-within:`: the ux-review
          // hover-reveal gate requires the control's own focus to reveal it, or
          // it is unreachable by keyboard.
          coarse
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 focus:opacity-100 group-focus-within:opacity-100',
          // The icon is ~18px with its padding. A `before:` overlay lifts the hit
          // target to 44px on a coarse pointer without changing the row's layout
          // (rule 253's pattern) — 18 + 2*13 = 44.
          coarse ? 'before:absolute before:inset-[-13px] before:content-[""]' : '',
          // `focus-visible:` deliberately, NOT `focus:` — the Schedule tree is the
          // standing carve-out to rule 4's standalone-control form (rule 137).
          // Do not "convert" this to `focus:` on a sweep.
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
        ].join(' ')}
        aria-label={`Open ${task.name}`}
        data-testid="row-open-task"
      >
        <ArrowUpRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </Tooltip>
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
    // "item", not "task": a summary rolls up whatever is under it, and that
    // set can contain phases and milestones. Naming them tasks is not merely
    // off-vocabulary here, it is factually wrong about what was summed (#3027).
    const noun = childCount === 1 ? ROW_NOUN : ROW_NOUN_PLURAL;
    const rollsUpFrom = `Rolls up from ${childCount} ${noun}. Change an item to change this.`;
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
      // #3258. The Finish cell's em-dash is right — a milestone genuinely has one
      // date, and its aria text says which column carries it. Dur is a different
      // claim: an em-dash reads as UNKNOWN, and a gate whose duration is unknown is
      // exactly the wrong thing to say about the one row type defined by having
      // none. With both cells dashed, the diamond asserted the type and no cell
      // asserted the consequence. The zero is the point, so state it — in both
      // channels, since a sighted user reading `0d` is owed the same sentence the
      // screen-reader user gets (web rule 287).
      //
      // This only became visible once #3256 made the conversion write a real
      // milestone; before that every converted row was a zero-duration *task*, so
      // this branch never ran on the rows a user had just converted.
      aria-label={task.isMilestone ? '0 days — milestone' : `${task.duration} days`}
    >
      {task.isMilestone ? '0d' : `${task.duration}d`}
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
      // `overflow-hidden` bounds the allocation run to the column (#3154) — the
      // cell is a fixed width at the right edge of the outline, so an unbounded
      // child bleeds over the Gantt canvas.
      className="flex items-center shrink-0 overflow-hidden pl-2"
      style={{ width: widthPx }}
      role="gridcell"
      // The name states each assignee's units, derived from `chipTitle` — the same
      // formatter the tooltip and the visible run use, so the three cannot drift
      // (rule 328). Before #3154 it listed names only, so allocation was
      // unreachable by assistive tech.
      aria-label={
        task.isSummary
          ? 'Summary task — owner column empty'
          : formatOwnerCellLabel(task.assignees)
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
