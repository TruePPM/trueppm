import {
  memo,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { Task, TaskStatus } from '@/types';
import { BoardProgressRing } from './BoardProgressRing';
import { formatShortDate } from '@/features/schedule/scheduleUtils';
import { formatRelative } from '@/lib/formatRelative';
import { severityRagBand } from '@/hooks/useTaskDependencies';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { formatStoryPoints, storyPointsUnit } from '@/lib/storyPoints';
import { isTaskScheduled } from '@/lib/task';
import { PendingAcceptanceChip, pendingAcceptanceExplainer } from './PendingAcceptanceChip';
import { PendingSyncBadge } from './PendingSyncBadge';
import { useIsCardPendingSync } from './offline/boardOutboxStore';
import { ReadinessChip } from './ReadinessChip';
import { TypeBadge } from '@/features/project/backlog/components/TypeBadge';
import { classifyCardSignal, cardSignalToneClass } from './cardSignal';
import { phaseColor } from './phaseColors';
import { LinkIcon, WarningIcon, MoreHorizontalIcon, ClockIcon } from '@/components/Icons';
import { LabelPillRow } from '@/components/LabelPill';
import { CardPeekButton } from './CardPeekButton';
import { CustomFieldMarks, CustomFieldCompactPeek } from './CustomFieldMarks';
import type { ProjectCustomField } from '@/hooks/useProjectCustomFields';
import { useIsCoarsePointer } from '@/hooks/useIsCoarsePointer';
import { useIsOverflowing } from '@/hooks/useIsOverflowing';

export type BoardDensity = 'compact' | 'comfortable' | 'detailed';

/**
 * Sprint scope-injection accept/reject affordance bundle (ADR-0102).
 *
 * Threaded from `BoardView` (which owns the project/sprint context and the
 * mutations) so a pending card can offer a single-tap accept (✓) and a reject
 * in the overflow menu. `canManage` is the render-gate (`useCanManageScope`,
 * role >= ADMIN) — the server is the real gate. `offline` disables the
 * controls without queueing (frontend rule 152). Absent → no controls (e.g.
 * the drag overlay, or a non-pending card).
 */
export interface BoardCardScopeActions {
  canManage: boolean;
  offline: boolean;
  onAccept: (task: Task) => void;
  onReject: (task: Task) => void;
}

/** Which EVM performance indicators to show on cards (issue 185). */
export type EvmMode = 'spi' | 'cpi' | 'both' | 'off';

interface BoardCardProps {
  task: Task;
  isOverlay?: boolean;
  isStalled?: boolean;
  /**
   * Move-to-status handler. Takes the card's own `task` so the parent can pass
   * a single stable reference for the whole grid instead of a per-card closure
   * (`(newStatus) => onMenuMove(task, newStatus)`), which would allocate a new
   * identity for every card on every render and defeat `React.memo` (issue 1520).
   */
  onMenuMove: (task: Task, newStatus: TaskStatus) => void;
  columns: { status: TaskStatus; label: string; slaDays?: number }[];
  density?: BoardDensity;
  /**
   * Per-assignee peak overallocation factor (resourceId → factor > 1.0).
   * Source: useBoardOverallocation. Optional; absent on the drag overlay.
   */
  overallocByResource?: Map<string, number>;
  /** True when this card is the keyboard-focused card (issue 195). */
  isKeyboardFocused?: boolean;
  /** True when card should dim because it's not in the active dep highlight set (issue 182). */
  isDimmed?: boolean;
  /**
   * True when the card does not match the active board facet filters (issue 1091).
   * Distinct from {@link isDimmed}: a filtered-out card is dimmed harder (30%) and
   * removed from the tab order + hidden from assistive tech (aria-hidden +
   * tabIndex -1 + pointer-events-none) so faceting never strands keyboard focus
   * or screen-reader focus on a card the user has filtered away.
   */
  isFilteredOut?: boolean;
  /** Click handlers for chain / risk icons (issue 182, issue 188). Task-aware so
   *  the parent passes one stable reference per grid, not a per-card closure. */
  onShowDeps?: (task: Task) => void;
  onShowRisks?: (task: Task) => void;
  /** Hover handler for the chain icon — drives board-level "dim non-connected"
   *  state. Task-aware (`taskId | null`) so the parent passes one stable
   *  reference; the enter/leave closures are bound internally from `task`. */
  onChainHover?: (taskId: string | null) => void;
  /** Which EVM indicators to show (issue 185). Default 'off'. */
  showEvm?: EvmMode;
  /** When true, show budget/cost chips when task has cost data (issue 189). */
  showCost?: boolean;
  /**
   * Card click handler (issue 304). Fires on the root only when no child
   * (chain icon, risk icon, ··· menu) intercepts via `stopPropagation`. Mouse,
   * keyboard (Enter/Space), and touch tap all flow through here. The anchor
   * element is the card root — used by `BoardView` to position the popover.
   */
  onCardClick?: (task: Task, anchor: HTMLElement) => void;
  /** Sprint scope-injection accept/reject affordance (ADR-0102). When the task
   *  is pending (`task.sprintPending`) and this is supplied, the card renders
   *  muted with a single-tap ✓ accept (gated by `canManage`) and a reject in
   *  the overflow menu. */
  scopeActions?: BoardCardScopeActions;
  /**
   * Read-only board (closed sprint, issue 1141; or a Viewer, #2146). When true,
   * drag-to-assign is disabled and the cursor is default — but click-to-open and
   * scroll still work, because reading the board is the use case. The card is NOT
   * marked `aria-disabled` (it stays a usable button for opening detail); the
   * ClosedSprintBanner announces the closed-sprint state.
   */
  readOnly?: boolean;
  /**
   * Project custom-field definitions to render on the card, flagged `showOnCard` and
   * pre-sorted by `order` (#2144). Values come from `task.customFields`. The board-level
   * master switch (web-rule 271) is applied upstream — BoardView passes an empty array
   * when muted — so the card stays unaware of board-view state. Pass a stable (memoized)
   * array so `React.memo` is not defeated; empty/undefined renders no field band.
   */
  customFieldDefs?: ProjectCustomField[];
}

/**
 * Get initials from a full name — at most two chars.
 */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Format an entry-stamp line and compute dwell time.
 * Returns daysAgo for use by the SLA aging indicator (issue 192).
 */
function entryStamp(task: Task): { text: string; isStalled: boolean; daysAgo: number | null } {
  if (!task.statusEnteredAt) {
    return { text: '', isStalled: false, daysAgo: null };
  }

  // dwell + the stalled verdict are server-owned (issue 992, ADR-0115): the API returns
  // dwell_days (the raw fact) and is_stalled (the verdict). Fall back to a client
  // derivation only for tasks not carrying the server fields yet (legacy fixtures /
  // optimistic rows) so the stamp never blanks mid-migration.
  const enteredMs = new Date(task.statusEnteredAt).getTime();
  const derivedDays = Math.floor((Date.now() - enteredMs) / 86_400_000);
  const daysAgo = task.dwellDays ?? derivedDays;
  const daysLabel = daysAgo === 1 ? '1d ago' : `${daysAgo}d ago`;

  // COMPLETE implies 100% regardless of the stored progress value, so the
  // entry stamp matches the column it lives in.  Stalled is also a no-op on
  // DONE — a card sitting in DONE for weeks isn't "stalled," it's finished.
  const effectiveProgress = task.status === 'COMPLETE' ? 100 : task.progress;
  const isStalled =
    task.isStalled ?? (task.status !== 'COMPLETE' && daysAgo > 3 && effectiveProgress < 100);

  return {
    text: `Entered at ${effectiveProgress}% · ${daysLabel}${isStalled ? ' — stalled' : ''}`,
    isStalled,
    daysAgo,
  };
}

/** Format a currency value compactly (e.g. 125000 → "$125K"). */
function fmtCurrency(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}

// Left accent bar color per readiness state (issue 179).
// CP (critical) overrides all; at-risk overrides estimated/ready/baselined.
// `showCriticalState` gates the red CP override so backlog/uncommitted tasks
// don't display scheduled-state styling (issue 332).
function accentBarClass(task: Task, showCriticalState: boolean): string {
  if (showCriticalState) return 'bg-semantic-critical';
  const r = task.readiness ?? 'estimated';
  switch (r) {
    case 'idea':
      return 'bg-transparent';
    case 'baselined':
      return 'bg-semantic-on-track';
    default:
      return 'bg-brand-primary';
  }
}

/** Tooltip text for a critical-path task (issue 181 / WCAG 1.4.1). */
function cpTooltip(_task: Task): string {
  return 'On critical path — any delay here will delay the project end date';
}

// Chip tone (bg + border + text) for the inline risk signal chip — maps the
// 5-tier severity register down to a 3-tier RAG palette (ADR-0035 §Q2; full
// breakdown lives in the RiskPopover for color-blind safety), matching the
// float/SPI chip tone patterns below so the in-flow signal chips read as one
// calm family.
function riskChipToneClass(severity: number | null | undefined): string {
  const band = severityRagBand(severity);
  switch (band) {
    case 'red':
      return 'bg-semantic-critical-bg border-semantic-critical/30 text-semantic-critical';
    case 'amber':
      return 'bg-brand-accent/10 border-brand-accent/30 text-brand-accent-dark';
    case 'green':
      return 'bg-semantic-on-track-bg border-semantic-on-track/30 text-semantic-on-track';
    default:
      return 'bg-neutral-surface-sunken border-neutral-border text-neutral-text-secondary';
  }
}

function BoardCardImpl({
  task,
  isOverlay,
  isStalled: isOverrideStalled,
  onMenuMove,
  columns,
  density = 'comfortable',
  overallocByResource,
  isKeyboardFocused = false,
  isDimmed = false,
  isFilteredOut = false,
  onShowDeps,
  onShowRisks,
  onChainHover,
  showEvm = 'off',
  showCost = false,
  onCardClick,
  scopeActions,
  readOnly = false,
  customFieldDefs,
}: BoardCardProps) {
  const itl = useIterationLabel();
  // Resolved estimation scale for the point badge (ADR-0510, #2027). useProject
  // shares the ['project', id] react-query cache, so every card reads it without a
  // new request; Fibonacci until the project detail resolves.
  const estimationScale =
    useProject(useProjectId()).data?.effective_estimation_scale ?? 'fibonacci';
  // A read-only board disables drag-to-assign (closed sprint, issue 1141; or a
  // Viewer, #2146). dnd-kit clears `listeners` when disabled but its `attributes`
  // still carry `role="button"` + `aria-disabled="true"`, which makes the card
  // unoperable to keyboard/AT users (and Playwright reads it as "not enabled").
  // A read-only card is still click-to-open detail, so drop the drag attributes
  // and keep it a plain focusable button — never aria-disabled.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled: readOnly,
  });
  // dnd-kit's `attributes` carry `aria-describedby` pointing at its live-region
  // instruction ("To pick up a draggable item, press space or enter…"). That
  // pickup path is dead on this board: we override `onKeyDown` below with the
  // open-detail handler, so the KeyboardSensor activator never fires (#2194).
  // Announcing a keyboard-drag that cannot happen is a false SR instruction, so
  // we drop only that association — the keyboard path for moving a card is the
  // card's ⋯ → "Move to…" menu. `aria-roledescription="draggable"` is kept: the
  // card genuinely is pointer/touch-draggable, and it is the card-root selector.
  // True while a pointer press is in flight on this card. On pointer-down the
  // browser will move DOM focus itself (to the card, or to the exact control the
  // user pressed — a chain chip, the ··· menu), and `focusedCardId` also updates
  // via the card's pointer-down / focus-capture tracking. The keyboard-focus
  // effect below must NOT also `focus()` the card root during that window: at
  // pointer-down time `document.activeElement` is still `body`, so it would look
  // "ambient", and stealing focus mid-press cancels the click the user intended
  // (#2194 — clicking the chain chip opened the card instead of the deps popover).
  const pointerFocusRef = useRef(false);
  const markPointerFocus = () => {
    pointerFocusRef.current = true;
  };
  const clearPointerFocus = () => {
    pointerFocusRef.current = false;
  };

  // `data-board-card` marks the card root so the keyboard-focus effect can tell
  // "focus is on another board card" (a legit j/k/l/h hop, follow it) from
  // "focus is on an unrelated control" (a resize separator, an in-card button —
  // don't steal it). See the isKeyboardFocused effect below (#2194).
  const dragProps = readOnly
    ? {
        role: 'button' as const,
        tabIndex: 0,
        'data-board-card': '',
        onPointerDownCapture: markPointerFocus,
        onPointerUpCapture: clearPointerFocus,
        onPointerCancelCapture: clearPointerFocus,
      }
    : {
        ...listeners,
        ...attributes,
        'aria-describedby': undefined,
        'data-board-card': '',
        onPointerDownCapture: markPointerFocus,
        onPointerUpCapture: clearPointerFocus,
        onPointerCancelCapture: clearPointerFocus,
      };

  // Bind the task-aware chain-hover handler to this card once per render. These
  // live inside the component (not in the parent's map) so the card's incoming
  // props stay a single stable reference and React.memo can skip it (issue 1520).
  const handleChainHoverEnter = () => onChainHover?.(task.id);
  const handleChainHoverLeave = () => onChainHover?.(null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  // Worst-offender peek (issue 1305): on touch (no hover) the primary badge toggles
  // the full chip set open; `peekOpen` keeps it open after blur/un-hover. Desktop
  // hover/focus reveal it without this flag via group-hover / group-focus-within.
  const [peekOpen, setPeekOpen] = useState(false);
  const signalBadgeRef = useRef<HTMLButtonElement>(null);
  // Compact-bar touch affordances (#1947, web-rule 256). On a coarse pointer the
  // compact card's hover-only health badge and truncated title have no reachable
  // channel, so each promotes to a tap-to-peek `CardPeekButton`. Both hooks are
  // called unconditionally here (before the early-return branches) to satisfy the
  // rules of hooks; on a fine pointer `coarsePointer` is false and the compact
  // branch renders today's exact DOM (byte-identical desktop).
  const coarsePointer = useIsCoarsePointer();
  const titleRef = useRef<HTMLSpanElement>(null);
  const titleOverflowing = useIsOverflowing(titleRef);
  const menuRef = useRef<HTMLDivElement>(null);
  // issue 838: roving-focus keyboard nav for the overflow menu + submenu.
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  // Focus the first menuitem when the menu opens so keyboard users land inside it.
  // Depends only on menuOpen — opening the Move-to submenu must not steal focus
  // back to the first item.
  useEffect(() => {
    if (!menuOpen) return;
    const first = menuPanelRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [menuOpen]);

  // Arrow/Home/End/Escape navigation across the menu's visible menuitems
  // (including submenu items once Move-to is expanded). Escape closes and
  // restores focus to the ··· trigger (WCAG 2.1.1 menu pattern, issue 838).
  const onMenuKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setMenuOpen(false);
      setMoveOpen(false);
      menuTriggerRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(
      menuPanelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current <= 0 ? items.length - 1 : current - 1;
    items[next]?.focus();
  }, []);

  // Remember the real card's rendered height so the drag placeholder matches
  // it (rule 102: placeholder of equal height).  Updated on every non-drag
  // render so varying card content — CP pill, assignees, entry stamp, nudge —
  // produces an equal-height slot.
  const cardElRef = useRef<HTMLDivElement | null>(null);
  const lastHeightRef = useRef<number>(0);
  const measureCardRef = useCallback(
    (node: HTMLDivElement | null) => {
      cardElRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );
  useLayoutEffect(() => {
    if (isDragging) return;
    const h = cardElRef.current?.offsetHeight;
    if (h && h > 0) lastHeightRef.current = h;
  });

  // j/k/l/h board navigation must move *real* DOM focus, not just paint a ring
  // (#2194 — the previous model set `focusedCardId` state only, so screen readers
  // announced nothing, focus never moved, and Enter/E never reached a card). When
  // this card becomes the keyboard-focused one, pull DOM focus to it and scroll
  // it into view so SR announces its aria-label and the card's own Enter/Space
  // open-handler is now the active target.
  //
  // But `focusedCardId` is *not* keyboard-only — it is also set on pointer down
  // and focus-capture over a card (tracking) and during drag. If we blindly
  // `focus()` on every change we steal focus from whatever the user is actually
  // operating: an in-card control (chain/risk chip, ··· menu) or an unrelated
  // widget like the column resize separator. So we only pull focus when the move
  // is plausibly a keyboard hop — focus is ambient (body) or already sitting on
  // another board card — and never when focus is already inside *this* card.
  useEffect(() => {
    if (!isKeyboardFocused || isFilteredOut) return;
    // A pointer press is driving focus natively — don't fight it (see the ref).
    if (pointerFocusRef.current) return;
    const el = cardElRef.current;
    if (!el) return;
    const active = document.activeElement;
    // Focus already within this card (e.g. the user clicked its chain chip): leave
    // it on that control — don't yank it to the card root.
    if (el.contains(active)) return;
    // Only follow keyboard board-nav: from body (ambient) or from another card.
    const fromAmbient = active == null || active === document.body;
    const fromAnotherCard = active instanceof Element && active.closest('[data-board-card]') != null;
    if (!fromAmbient && !fromAnotherCard) return;
    el.focus({ preventScroll: true });
    // Optional-chained: jsdom has no layout and does not implement scrollIntoView.
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [isKeyboardFocused, isFilteredOut]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setMoveOpen(false);
      }
    }
    document.addEventListener('pointerdown', handleClick);
    return () => document.removeEventListener('pointerdown', handleClick);
  }, [menuOpen]);

  // Escape collapses a tap-opened worst-offender peek and returns focus to its
  // badge (issue 1305) — matching the menu's Escape pattern above.
  useEffect(() => {
    if (!peekOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPeekOpen(false);
        signalBadgeRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [peekOpen]);

  const otherColumns = columns.filter((c) => c.status !== task.status);
  // A screen-reader user tabbing card-to-card cannot tell which column/status a
  // card sits in — the column cells are plain <div>s with no programmatic
  // context (#2204). Resolve this card's column label and fold it into the
  // card's accessible name so the status travels with focus. Falls back to the
  // raw status key when the column has no configured label.
  const columnLabel = columns.find((c) => c.status === task.status)?.label ?? task.status;
  const { text: stampText, isStalled: derivedStalled, daysAgo } = entryStamp(task);
  const isStalled = isOverrideStalled ?? derivedStalled;
  // COMPLETE clamps display progress to 100% so the ring, the bottom strip,
  // and the aria-label all reflect "done" regardless of the stored value.
  // The raw `task.progress` is still used for SPI math (line 133) since SPI
  // measures actual delivered work against plan, not status.
  const effectiveProgress = task.status === 'COMPLETE' ? 100 : task.progress;

  // Aging / dwell-time indicator (issue 192)
  const slaDays = columns.find((c) => c.status === task.status)?.slaDays;
  const isAging = daysAgo !== null && slaDays !== undefined && daysAgo > slaDays;
  const isPastTwiceSla = isAging && daysAgo > 2 * slaDays;
  const isIdea = (task.readiness ?? 'estimated') === 'idea';
  const isCompact = density === 'compact';
  const isDetailed = density === 'detailed';

  // CPM marks every dated task with isCritical/totalFloat, including backlog
  // ideas the PM hasn't committed to. Suppress the red CP signal and float
  // chip until the task is scheduled (plannedStart set or in a sprint) — see
  // issue 332. The CPM data is still passed through unchanged; only the
  // display gates on commitment.
  const isScheduled = isTaskScheduled(task);

  // ADR-0102: a pending-acceptance injection is visible but not yet committed.
  // The card is muted and — per the ux-design — the red CP signal is suppressed
  // while pending (the task isn't part of the commitment, so its critical-path
  // status is not yet a team concern; it reappears on accept). The neutral
  // PendingAcceptanceChip carries the read-state instead.
  const isPending = task.sprintPending === true;
  const showCriticalState = task.isCritical && isScheduled && !isPending;
  // #1472: the pending chip becomes a tap-to-explain disclosure on the board so a
  // plain Member (who has no reachable accept/reject) can understand the signal.
  // Role-neutral, iteration-label-aware copy built in the shared helper.
  const pendingExplainer = pendingAcceptanceExplainer(itl.lower);

  // ADR-0220: does this card have a status move queued offline (IndexedDB) that
  // has not yet flushed? Subscribed from the board outbox store so the badge
  // appears/clears reactively without prop-drilling through the board grid.
  const isPendingSync = useIsCardPendingSync(task.id);

  // EVM indicators (issue 185): SPI + its band are server-owned (issue 990 / API-first
  // issue 986) — the card renders them, it no longer re-derives earned%/planned% from
  // baseline dates in the browser. CPI stays sourced from the (currently unpopulated)
  // cost field until the cost model ships (issue 73).
  const spi = task.spi ?? null;
  const spiBand = task.spiBand ?? null;
  const cpi = task.cpi ?? null;
  const showSpiChip =
    !isCompact && showEvm !== 'off' && (showEvm === 'spi' || showEvm === 'both') && spi !== null;
  const showCpiChip =
    !isCompact && showEvm !== 'off' && (showEvm === 'cpi' || showEvm === 'both') && cpi !== null;

  // Cost chip (issue 189): shown when toggle is on and task has BAC data.
  const hasCostData = task.budgetAtCompletion != null;
  const showCostChip = showCost && !isCompact && hasCostData;

  // PPM signal icons (chain link, risk warn) sit to the left of the ··· menu.
  // ADR-0035 + brand rule 5: 16px icon, ≥44×44 hit area via inset before pseudo-element.
  const predecessorCount = task.predecessorCount ?? 0;
  const isBlocked = task.isBlocked ?? false;
  const linkedRisksCount = task.linkedRisksCount ?? 0;
  const linkedRisksMaxSeverity = task.linkedRisksMaxSeverity ?? null;
  const showChain = predecessorCount > 0;
  const showRisk =
    linkedRisksCount > 0 && linkedRisksMaxSeverity !== null && linkedRisksMaxSeverity > 0;

  // Float data feeds both the worst-offender classifier (issue 1305) and the inline
  // float chip, so it's derived here before any render branch. CP tasks have 0d
  // float by definition; otherwise show totalFloat when set. Suppressed on
  // unscheduled tasks — CPM produces float for every dated task, including
  // backlog ideas (issue 332) — so the classifier reads null, not garbage.
  const hasFloatData =
    isScheduled && (task.isCritical || (task.totalFloat !== undefined && task.totalFloat !== null));
  const floatDays = task.isCritical ? 0 : (task.totalFloat as number);

  // Worst-offender signal (issue 1305, ADR-0191 §4): the single highest-severity
  // health signal, shown as one primary badge so the card stays calm. The full
  // chip set stays reachable in the comfortable peek and fully inline at detailed
  // density (expandable, never lossy). EVM tiers feed in only when the board's
  // EVM toggle is on, so the badge never contradicts a hidden chip.
  const evmShowsSpi = showEvm === 'spi' || showEvm === 'both';
  const evmShowsCpi = showEvm === 'cpi' || showEvm === 'both';
  const cardSignal = classifyCardSignal({
    isBlocked,
    predecessorCount,
    isAging,
    isStalled,
    isPastTwiceSla,
    daysAgo,
    showCriticalState,
    floatDays: hasFloatData ? floatDays : null,
    spiBand: evmShowsSpi ? spiBand : null,
    cpi: evmShowsCpi ? cpi : null,
  });
  // Stable id so the badge's aria-controls points at its disclosure peek.
  const peekId = `card-peek-${task.id}`;

  // Signal chips (dependency / linked-risk) rendered INLINE in the badge/title
  // flow as shrink-0 chips (issue 1735, design §01). Previously an
  // absolute-positioned cluster at `right-9` that overwrote the truncating title
  // and collided with the ··· menu; now the title is `flex-1 min-w-0` and these
  // are `shrink-0`, so truncation happens before the icons at any density. Emoji
  // (🔗 / ⚠) are replaced with the SVG LinkIcon / WarningIcon (inherit
  // currentColor, so the blocked-red tint applies to the glyph), and the count
  // renders beside the icon as one chip. They stay interactive: the chain chip
  // opens the dependency popover + drives board dep-highlight hover; the risk
  // chip opens the risk popover.
  const signalChips =
    showChain || showRisk ? (
      <>
        {showChain && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onShowDeps?.(task);
            }}
            onPointerEnter={handleChainHoverEnter}
            onPointerLeave={handleChainHoverLeave}
            onFocus={handleChainHoverEnter}
            onBlur={handleChainHoverLeave}
            className={[
              // `before:inset-[-12px]` restores the ≥44px touch target (rule 5)
              // the emoji buttons had — the chip itself is ~20px, so the invisible
              // pseudo pad carries the hit area (mirrors the ··· menu / accept ✓ /
              // worst-offender badge on this card).
              'relative shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded-chip text-xs border font-medium',
              "before:absolute before:inset-[-12px] before:content-['']",
              'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1',
              isBlocked
                ? 'bg-semantic-critical-bg border-semantic-critical/30 text-semantic-critical'
                : 'bg-neutral-surface-sunken border-neutral-border text-neutral-text-secondary',
            ].join(' ')}
            aria-label={
              isBlocked
                ? `Blocked by ${predecessorCount} ${predecessorCount === 1 ? 'dependency' : 'dependencies'}. Press D to view.`
                : `${predecessorCount} ${predecessorCount === 1 ? 'dependency' : 'dependencies'}. Press D to view.`
            }
          >
            <LinkIcon className="h-3 w-3" aria-hidden="true" />
            <span className="tppm-mono leading-none">{predecessorCount}</span>
          </button>
        )}
        {showRisk && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onShowRisks?.(task);
            }}
            className={[
              // `before:inset-[-12px]` restores the ≥44px touch target (rule 5)
              // the emoji buttons had — the chip itself is ~20px, so the invisible
              // pseudo pad carries the hit area (mirrors the ··· menu / accept ✓ /
              // worst-offender badge on this card).
              'relative shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded-chip text-xs border font-medium',
              "before:absolute before:inset-[-12px] before:content-['']",
              'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1',
              riskChipToneClass(linkedRisksMaxSeverity),
            ].join(' ')}
            aria-label={
              `${linkedRisksCount} linked risk${linkedRisksCount === 1 ? '' : 's'}, ` +
              `severity ${severityRagBand(linkedRisksMaxSeverity) ?? 'low'}. Click to view.`
            }
          >
            <WarningIcon className="h-3 w-3" aria-hidden="true" />
            <span className="tppm-mono leading-none">{linkedRisksCount}</span>
          </button>
        )}
      </>
    ) : null;

  // Shared menu button rendered in all non-overlay/non-dragging states
  const menuButton = (
    <div ref={menuRef} className="absolute top-2 right-2">
      <button
        ref={menuTriggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen(!menuOpen);
          setMoveOpen(false);
        }}
        className="relative before:absolute before:inset-[-10px] before:content-[''] w-6 h-6 flex items-center justify-center rounded-control text-neutral-text-secondary
          hover:bg-neutral-surface-raised opacity-0 group-hover:opacity-100 max-md:opacity-100
          focus:opacity-100 focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-1"
        aria-label={`Actions for ${task.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        ···
      </button>

      {menuOpen && (
        <div
          ref={menuPanelRef}
          role="menu"
          tabIndex={-1}
          aria-label={`Actions for ${task.name}`}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-7 z-20 bg-neutral-surface border border-neutral-border
            rounded-card py-1 min-w-[160px] focus:outline-none"
        >
          {/* Reject scope injection (ADR-0102) — critical text, gated. The
              additive accept is the single-tap ✓; reject (destructive) lives
              here. Hidden offline (rule 152: never queue a stale decision). */}
          {isPending && scopeActions?.canManage && !scopeActions.offline && (
            <button
              type="button"
              role="menuitem"
              className="w-full text-left px-3 py-2 text-sm text-semantic-critical
                hover:bg-semantic-critical-bg
                focus:ring-2 focus:ring-semantic-critical focus:ring-inset"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                setMoveOpen(false);
                scopeActions.onReject(task);
              }}
            >
              Reject from {itl.lower}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="w-full text-left px-3 py-2 text-sm text-neutral-text-primary
              hover:bg-neutral-surface-raised
              focus:ring-2 focus:ring-brand-primary focus:ring-inset"
            onClick={(e) => {
              e.stopPropagation();
              setMoveOpen(!moveOpen);
            }}
            aria-haspopup="menu"
            aria-expanded={moveOpen}
          >
            Move to…
          </button>

          {moveOpen && (
            <div role="menu" className="border-t border-neutral-border">
              {otherColumns.map((col) => (
                <button
                  key={col.status}
                  type="button"
                  role="menuitem"
                  className="w-full text-left px-5 py-2 text-sm text-neutral-text-primary
                    hover:bg-neutral-surface-raised
                    focus:ring-2 focus:ring-brand-primary focus:ring-inset"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMenuMove(task, col.status);
                    setMenuOpen(false);
                    setMoveOpen(false);
                  }}
                >
                  {col.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  // Single-tap accept ✓ for a pending scope injection (ADR-0102 §5). Additive
  // action → no confirm (frontend rule 150). Sits left of the ··· menu. Gated
  // by canManage; hidden offline (rule 152). Reject is in the overflow menu.
  const acceptIcon =
    isPending && scopeActions?.canManage && !scopeActions.offline ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          scopeActions.onAccept(task);
        }}
        aria-label={`Accept ${task.name} into the ${itl.lower}`}
        title={`Accept into the ${itl.lower}`}
        className="absolute top-2 right-9 w-6 h-6 flex items-center justify-center rounded-control
          text-brand-primary hover:bg-brand-primary/10
          before:absolute before:inset-[-10px] before:content-['']
          focus:opacity-100 focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-1 focus:outline-none"
      >
        <span aria-hidden="true">✓</span>
      </button>
    ) : null;

  // Shared card container class. A read-only (closed-sprint) card drops the
  // grab cursor — it's still clickable to open detail, just not draggable (issue 1141).
  const containerClass = [
    'bg-neutral-surface border rounded-card relative group',
    readOnly ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
    'focus:ring-2 focus:ring-brand-primary focus:ring-offset-1',
    // v2 fluidity (ADR-0126): subtle hover-lift, no shadow (rule 1) — the card's
    // own border supplies the edge. Single multi-prop transition so opacity
    // (dim states) and the lift share one declaration; lift is motion-safe (rule 70).
    'transition-[opacity,transform] duration-fast ease-brand motion-safe:hover:-translate-y-px',
    showCriticalState
      ? 'border-semantic-critical border-2'
      : isIdea
        ? 'border-dashed border-neutral-border'
        : 'border-neutral-border',
    isKeyboardFocused
      ? 'ring-2 ring-brand-primary ring-offset-1 ring-offset-neutral-surface-sunken'
      : '',
    // A facet-filtered-out card dims harder than a dep/search dim and wins over
    // both (issue 1091) — it's the strongest "not part of your current view" cue.
    isFilteredOut ? 'opacity-30 pointer-events-none' : isDimmed ? 'opacity-40' : '',
    // Pending injections are de-emphasized (ADR-0102 §6) — but not as faint as
    // a dimmed/dep-highlight card, so the chip + accept tick stay legible.
    isPending && !isDimmed && !isFilteredOut ? 'opacity-70' : '',
  ].join(' ');

  // Overlay card — the floating drag copy (rule 102)
  if (isOverlay) {
    return (
      <div
        className="bg-neutral-surface border border-neutral-border rounded-card p-3
          ring-2 ring-brand-primary opacity-60 scale-105 motion-safe:rotate-1
          w-[85vw] md:w-auto md:min-w-[200px]"
      >
        <div className="flex items-center gap-1.5">
          <BoardProgressRing
            progress={effectiveProgress}
            isCritical={showCriticalState}
            isStalled={isStalled}
          />
          <p className="text-sm font-medium text-neutral-text-primary truncate">{task.name}</p>
        </div>
      </div>
    );
  }

  // Placeholder slot when this card is being dragged (rule 102) — height
  // matches the source card so surrounding cards don't jump during drag.
  if (isDragging) {
    return (
      <div
        className="border-2 border-dashed border-neutral-border rounded-card"
        style={{ height: lastHeightRef.current || 76 }}
      />
    );
  }

  // Compact density — title + CP chip + progress strip, ~36px (issue 193)
  if (isCompact) {
    const progressColor = showCriticalState
      ? 'bg-semantic-critical'
      : effectiveProgress === 100
        ? 'bg-semantic-on-track'
        : 'bg-brand-primary';
    return (
      <div
        ref={measureCardRef}
        {...dragProps}
        onClick={(e) => onCardClick?.(task, e.currentTarget)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && e.currentTarget === e.target) {
            // The focused card owns Enter/Space (open detail). Stop it here so
            // the window-level board keyboard registry doesn't double-handle it
            // (#2194 — cheatsheet "Enter — Open card detail" is now real via
            // this handler once j/k/l/h moves DOM focus to the card).
            e.preventDefault();
            e.stopPropagation();
            onCardClick?.(task, e.currentTarget);
          }
        }}
        className={containerClass}
        role="button"
        tabIndex={isFilteredOut ? -1 : 0}
        // `inert` (React 19 boolean prop) is the real fix (#2204): it removes a
        // facet-filtered-out card AND its inner buttons (··· menu, signal chips)
        // from the tab order — `aria-hidden` alone did NOT (aria-hidden hides
        // from AT but does not remove focusability, so keyboard focus still
        // landed on cards the user filtered away). `aria-hidden` is retained
        // because inert is not yet modeled by every a11y tree consumer.
        inert={isFilteredOut || undefined}
        aria-hidden={isFilteredOut || undefined}
        aria-label={`${task.name}, ${effectiveProgress}% complete${showCriticalState ? ', critical path' : ''}, in ${columnLabel}`}
      >
        <div
          className={`absolute left-0 inset-y-0 w-1 rounded-l-card ${accentBarClass(task, showCriticalState)}`}
          aria-hidden="true"
        />
        <div className="pl-2.5 pr-8 py-2 flex items-center gap-1 min-w-0">
          <span
            ref={titleRef}
            className={[
              'text-xs font-medium truncate flex-1 min-w-0',
              showCriticalState
                ? 'text-semantic-critical font-semibold'
                : isIdea
                  ? 'text-neutral-text-disabled italic'
                  : 'text-neutral-text-primary',
            ].join(' ')}
            title={showCriticalState ? cpTooltip(task) : task.name}
          >
            {task.name}
          </span>
          {/* Title disclosure (#1947, web-rule 256). The truncated title silently
              drops its tail on touch, where `title=` never surfaces. On a coarse
              pointer AND when the title actually overflows, render a dedicated
              end-of-title glyph button that peeks the full name; when it fits,
              render nothing (rule 122). The card body stays the task-open target
              — the title text itself is never the trigger. Fine pointer: no
              button, no aria (byte-identical desktop). */}
          {coarsePointer && titleOverflowing && (
            <CardPeekButton
              ariaLabel={`Show full title: ${task.name}`}
              peekAriaLabel="Full task title"
              triggerContent={
                <MoreHorizontalIcon
                  className="h-3.5 w-3.5 text-neutral-text-secondary"
                  aria-hidden="true"
                />
              }
            >
              {task.name}
            </CardPeekButton>
          )}
          {isPending && (
            <PendingAcceptanceChip compact explainer={pendingExplainer} className="shrink-0" />
          )}
          {isPendingSync && <PendingSyncBadge compact className="shrink-0" />}
          {/* Worst-offender badge (issue 1305) — on the bar it is glyph-only
              (issue #1925): the single highest-severity glyph + tone is enough to
              scan by, and its word lives in srText. It subsumes the old CP chip
              (critical path is one of its tiers), so the red accent bar + name
              color still mark a CP card even when a higher signal (blocked/stale)
              wins the badge.

              On a coarse pointer (#1947, web-rule 256) the glyph's meaning is
              otherwise trapped in `title`/`aria-label` — unreachable on touch — so
              the badge promotes to a tap-to-peek `CardPeekButton` revealing the
              full `srText` sentence. The trigger keeps its semantic tone; the peek
              surface stays neutral (rule 253a). Closed state is portaled → zero
              added layout, so the 36px compact bar height is unchanged. Fine
              pointer: today's exact display-only `<span>` (byte-identical). */}
          {cardSignal &&
            (coarsePointer ? (
              <CardPeekButton
                ariaLabel={`${cardSignal.label}. What does this mean?`}
                peekAriaLabel={`${cardSignal.label} — explanation`}
                triggerClassName={`shrink-0 px-1 py-px rounded-chip text-xs border font-medium ${cardSignalToneClass(
                  cardSignal.tone,
                )}`}
                triggerContent={<span aria-hidden="true">{cardSignal.glyph}</span>}
              >
                {cardSignal.srText}
              </CardPeekButton>
            ) : (
              <span
                className={`shrink-0 inline-flex items-center px-1 py-px rounded-chip text-xs border font-medium ${cardSignalToneClass(
                  cardSignal.tone,
                )}`}
                title={cardSignal.srText}
                aria-label={cardSignal.srText}
              >
                <span aria-hidden="true">{cardSignal.glyph}</span>
              </span>
            ))}
          {/* Dependency / risk signal chips in-flow (issue 1735). Suppressed on a
              pending card, which shows the accept ✓ instead. */}
          {!isPending && signalChips}
          {/* Labels (ADR-0400): color dots only at compact density. */}
          {(task.labels?.length ?? 0) > 0 && (
            <span className="shrink-0">
              <LabelPillRow labels={task.labels ?? []} density="compact" />
            </span>
          )}
          {/* Custom fields (#2144): 0 inline on the 36px bar — one trailing ⊕N peek. */}
          {customFieldDefs && customFieldDefs.length > 0 && (
            <CustomFieldCompactPeek fields={customFieldDefs} values={task.customFields} />
          )}
        </div>
        {/* 3px progress strip at the bottom of each compact card */}
        <div
          className="absolute bottom-0 left-1 right-1 h-[3px] rounded-full overflow-hidden bg-neutral-border"
          aria-hidden="true"
        >
          <div className={`h-full ${progressColor}`} style={{ width: `${effectiveProgress}%` }} />
        </div>
        {acceptIcon}
        {menuButton}
      </div>
    );
  }

  // Comfortable and Detailed density
  const showNudge = task.progress === 100 && task.status !== 'COMPLETE';
  // Stream/label color tag (issue 1230): a stable per-stream hue keyed to the
  // card's epic, falling back to its WBS phase (summary parent) when the card
  // is not grouped under an epic. Cards in the same stream share a color so the
  // eye can cluster them at a glance. `null` when the card belongs to neither.
  const streamKey = task.parentEpic ?? task.parentId ?? null;
  const streamColor = streamKey ? phaseColor(streamKey) : null;
  // In detailed mode show all assignees; comfortable caps at 3
  const visibleAssignees = isDetailed ? task.assignees : task.assignees.slice(0, 3);
  const hiddenCount = isDetailed ? 0 : Math.max(0, task.assignees.length - 3);

  // Baseline variance hover panel (issue 186): calendar days between forecast finish and baseline.
  // Positive = late. Shown only when baselineFinish is present.
  const baselineVarianceDays: number | null = task.baselineFinish
    ? Math.round(
        (new Date(task.finish).getTime() - new Date(task.baselineFinish).getTime()) / 86_400_000,
      )
    : null;

  return (
    <div
      ref={measureCardRef}
      {...dragProps}
      onClick={(e) => onCardClick?.(task, e.currentTarget)}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.currentTarget === e.target) {
          e.preventDefault();
          onCardClick?.(task, e.currentTarget);
        }
      }}
      className={containerClass}
      role="button"
      tabIndex={isFilteredOut ? -1 : 0}
      // `inert` (React 19 boolean prop) is the real fix (#2204): it removes a
      // facet-filtered-out card AND its inner buttons (··· menu, signal chips)
      // from the tab order — `aria-hidden` alone did NOT (aria-hidden hides
      // from AT but does not remove focusability, so keyboard focus still
      // landed on cards the user filtered away). `aria-hidden` is retained
      // because inert is not yet modeled by every a11y tree consumer.
      inert={isFilteredOut || undefined}
      aria-hidden={isFilteredOut || undefined}
      aria-label={`${task.name}, ${effectiveProgress}% complete${showCriticalState ? ', critical path' : ''}, in ${columnLabel}`}
    >
      {/* Left accent bar — rounded-l-card matches card's border-radius so the bar
          respects the card corners without needing overflow-hidden on the parent. */}
      <div
        className={`absolute left-0 inset-y-0 w-1 rounded-l-card ${accentBarClass(task, showCriticalState)}`}
        aria-hidden="true"
      />

      {/* Card content — left-padded to clear the accent bar */}
      <div className="pl-2.5 pr-2.5 pt-2.5 pb-2.5">
        {/* Readiness chip — top-left (issue 179) */}
        {task.readiness && (
          <div className="mb-1.5">
            <ReadinessChip readiness={task.readiness} />
          </div>
        )}

        {/* Tech-debt badge (ADR-0178, issue 1076) — debt is the one type surfaced on
            the card face so a team can see remediation work at a glance; other
            types stay unbadged to keep the board calm. Neutral pill, word carries
            the meaning (rule 12). */}
        {task.taskType === 'tech_debt' && (
          <div className="mb-1.5">
            <TypeBadge type="tech_debt" />
          </div>
        )}

        {/* Priority rank — top-right, below the ··· menu */}
        {task.priorityRank !== undefined && (
          <span
            className="absolute top-2 right-8 text-xs text-neutral-text-disabled"
            aria-hidden="true"
          >
            #{task.priorityRank}
          </span>
        )}

        {/* Task name row */}
        <div className="flex items-center gap-1.5 pr-6 min-w-0">
          {!isIdea && (
            <BoardProgressRing
              progress={effectiveProgress}
              isCritical={showCriticalState}
              isStalled={isStalled}
            />
          )}
          <span
            className={[
              // line-clamp-2 (not truncate): comfortable/detailed cards wrap the
              // title to a second row so longer task names stay readable without
              // opening the card (issue #1924). Compact density keeps its
              // single-line bar (see the isCompact branch above).
              'text-xs font-medium line-clamp-2 min-w-0',
              showCriticalState
                ? 'text-semantic-critical font-semibold'
                : isIdea
                  ? 'text-neutral-text-disabled italic'
                  : 'text-neutral-text-primary',
            ].join(' ')}
            title={showCriticalState ? cpTooltip(task) : task.name}
          >
            {task.name}
          </span>
        </div>

        {/* Identity meta row (issue 1230) — a stream/label color tag (keyed to the
            card's epic, or its WBS phase parent when ungrouped), the visible
            short id, and a story-points pill. Each element is independently
            guarded so the row only renders when the card carries that datum. The
            color dot is decorative (aria-hidden): its meaning — which stream a
            card belongs to — is redundant grouping, never conveyed by color
            alone for anything load-bearing (WCAG 1.4.1). */}
        {(streamColor !== null || task.shortId || task.storyPoints != null) && (
          <div className="flex items-center gap-1.5 mt-1 min-w-0">
            {streamColor !== null && (
              <span
                className="inline-block w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: streamColor }}
                title="Stream"
                aria-hidden="true"
              />
            )}
            {task.shortId && (
              <span className="tppm-mono text-xs text-neutral-text-secondary truncate">
                {task.shortId}
              </span>
            )}
            {task.storyPoints != null && (
              <span
                className="ml-auto shrink-0 inline-flex items-center px-1.5 py-px rounded-chip text-xs font-semibold tppm-mono
                  bg-neutral-surface-sunken border border-neutral-border text-neutral-text-secondary"
                aria-label={`${task.storyPoints} story point${task.storyPoints === 1 ? '' : 's'}`}
              >
                {formatStoryPoints(task.storyPoints, estimationScale)}
                {storyPointsUnit(task.storyPoints, estimationScale)}
              </span>
            )}
          </div>
        )}

        {/* Badge row — worst-offender badge (or CP at detailed), pending chip,
            dependency/risk signal chips, assignees */}
        {((cardSignal && !isDetailed) ||
          showCriticalState ||
          isPending ||
          isPendingSync ||
          (!isPending && (showChain || showRisk)) ||
          task.assignees.length > 0 ||
          (task.labels?.length ?? 0) > 0 ||
          isIdea) && (
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            {isPending && <PendingAcceptanceChip explainer={pendingExplainer} />}
            {isPendingSync && <PendingSyncBadge />}
            {/* Comfortable: one interactive worst-offender badge that toggles the
                health-chip peek (issue 1305). Detailed: keep the CP chip inline since
                the full chip set is already shown below — no badge, no peek. */}
            {!isDetailed && cardSignal ? (
              <button
                ref={signalBadgeRef}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPeekOpen((v) => !v);
                }}
                aria-expanded={peekOpen}
                aria-controls={peekId}
                aria-label={`${cardSignal.srText}. Show health details.`}
                className={`relative inline-flex items-center gap-0.5 px-1.5 py-px rounded-chip text-xs border font-medium
                  before:absolute before:inset-[-12px] before:content-['']
                  focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
                  ${cardSignalToneClass(cardSignal.tone)}`}
              >
                <span aria-hidden="true">{cardSignal.glyph}</span>
                <span>{cardSignal.label}</span>
              </button>
            ) : (
              showCriticalState && (
                <span
                  className="inline-block px-1 py-px rounded-chip text-xs text-white bg-semantic-critical font-bold"
                  aria-hidden="true"
                >
                  CP
                </span>
              )
            )}
            {/* Dependency / risk signal chips in-flow (issue 1735). Suppressed on
                a pending card, which shows the accept ✓ instead. */}
            {!isPending && signalChips}
            {/* Labels (ADR-0400): 2 pills + overflow at comfortable, all at detailed. */}
            <LabelPillRow
              labels={task.labels ?? []}
              density={isDetailed ? 'detailed' : 'comfortable'}
            />
            {isIdea ? (
              <span
                className="inline-block w-5 h-5 rounded-full border border-dashed border-neutral-border
                  flex items-center justify-center text-xs text-neutral-text-secondary"
                aria-label="Unassigned"
              >
                ?
              </span>
            ) : (
              <>
                {visibleAssignees.map((a) => {
                  const overFactor = overallocByResource?.get(a.resourceId);
                  const overTooltip = overFactor
                    ? `${a.name} — ${overFactor.toFixed(1)}× allocated during this task ` +
                      `(calendar exceptions not applied)`
                    : `${a.name} (${Math.round(a.units * 100)}%)`;
                  return (
                    <span key={a.resourceId} className="relative inline-block" title={overTooltip}>
                      <span
                        className="inline-block px-1 py-px rounded-chip text-xs text-brand-primary bg-brand-primary/10 font-bold"
                        aria-label={overFactor ? `${a.name}, overallocated` : a.name}
                      >
                        {initials(a.name)}
                      </span>
                      {overFactor && (
                        <>
                          <span
                            aria-hidden="true"
                            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-semantic-critical border border-neutral-surface"
                          />
                          {isDetailed && (
                            <span className="ml-1 inline-flex items-center gap-0.5 text-xs px-1 py-px rounded-chip border bg-semantic-critical-bg border-semantic-critical/30 text-semantic-critical tppm-mono">
                              {overFactor.toFixed(1)}×
                            </span>
                          )}
                        </>
                      )}
                    </span>
                  );
                })}
                {hiddenCount > 0 && (
                  <span
                    className="inline-block px-1 py-px rounded-chip text-xs text-brand-primary bg-brand-primary/10 font-bold"
                    aria-hidden="true"
                  >
                    +{hiddenCount}
                  </span>
                )}
              </>
            )}
          </div>
        )}

        {/* Custom fields (#2144, web-rule 271) — lowest priority, last, hairline above.
            Comfortable: ≤3 inline + "+N more" peek; detailed: all inline. Empty → nothing. */}
        {customFieldDefs && customFieldDefs.length > 0 && (
          <CustomFieldMarks
            fields={customFieldDefs}
            values={task.customFields}
            density={isDetailed ? 'detailed' : 'comfortable'}
          />
        )}

        {/* Entry stamp — comfortable: only when non-empty; detailed: always when available */}
        {stampText && (
          <div
            className={[
              'text-xs mt-1',
              isStalled ? 'text-semantic-at-risk font-medium' : 'text-neutral-text-disabled',
            ].join(' ')}
          >
            {stampText}
          </div>
        )}

        {/* Notes freshness (ADR-0143, issue 740): when the task has a note, show how
            recently the last one landed — a lightweight signal that there's a
            why/decision record worth opening, without crowding compact cards. */}
        {!isCompact && task.latestNoteAt && (
          <div
            className="mt-1 inline-flex items-center gap-0.5 text-xs text-neutral-text-secondary"
            title={`Last note ${formatRelative(new Date(task.latestNoteAt))}`}
            aria-label={`Last note ${formatRelative(new Date(task.latestNoteAt))}`}
          >
            <span aria-hidden="true">📝</span>
            <span className="tppm-mono">{formatRelative(new Date(task.latestNoteAt))}</span>
          </div>
        )}

        {/* Health-chip peek (issue 1305). Detailed density shows the full chip set
            inline (no badge). Comfortable density collapses it behind the
            worst-offender badge. `group-hover:block` is a pointer-only
            convenience; keyboard and touch reveal flow through `peekOpen` so
            `aria-expanded` always matches what is visible and the collapse is
            never inert (no `group-focus-within` — that would desync the
            announced state). Keyboard + SR reachable, never lossy. */}
        <div
          id={peekId}
          role={isDetailed ? undefined : 'group'}
          aria-label={isDetailed ? undefined : 'Card health details'}
          className={isDetailed ? '' : peekOpen ? 'block' : 'hidden group-hover:block'}
        >
          {/* Aging / dwell-time indicator (issue 192): shown when dwell > column SLA. */}
          {isAging && (
            <div
              className={[
                'mt-1 inline-flex items-center gap-0.5 text-xs px-1 py-px rounded-chip border',
                isPastTwiceSla
                  ? 'bg-semantic-critical-bg border-semantic-critical/30 text-semantic-critical'
                  : 'bg-brand-accent/10 border-brand-accent/30 text-brand-accent-dark',
              ].join(' ')}
              title={`${daysAgo}d in column — SLA: ${slaDays}d`}
              aria-label={`${daysAgo} days in this column, exceeds ${slaDays}-day SLA`}
            >
              <ClockIcon aria-hidden="true" className="w-3.5 h-3.5" />
              <span className="tppm-mono">{daysAgo}d</span>
            </div>
          )}

          {/* Float chip — comfortable + detailed, when CPM data is present (issue 183).
            CP tasks always show "0d float" (red); non-CP shows totalFloat when defined. */}
          {!isCompact && hasFloatData && (
            <div className="mt-1">
              <span
                className={[
                  'inline-flex items-center gap-0.5 text-xs px-1 py-px rounded-chip border',
                  floatDays <= 0
                    ? 'bg-semantic-critical-bg border-semantic-critical/30 text-semantic-critical'
                    : floatDays < 3
                      ? 'bg-brand-accent/10 border-brand-accent/30 text-brand-accent-dark'
                      : 'bg-semantic-on-track-bg border-semantic-on-track/30 text-semantic-on-track',
                ].join(' ')}
              >
                {floatDays < 0 && (
                  <WarningIcon
                    className="inline-block h-3 w-3 align-[-0.125em]"
                    aria-hidden="true"
                  />
                )}
                <span className="tppm-mono">{floatDays}d float</span>
              </span>
            </div>
          )}

          {/* SPI chip — comfortable + detailed, when showEvm includes 'spi' (issue 185 / issue 990).
            SPI value + band are server-owned: on_track = green, at_risk = amber, behind = red. */}
          {showSpiChip && spi !== null && (
            <div className="mt-1">
              <span
                className={[
                  'inline-flex items-center gap-0.5 text-xs px-1 py-px rounded-chip border',
                  spiBand === 'on_track'
                    ? 'bg-semantic-on-track-bg border-semantic-on-track/30 text-semantic-on-track'
                    : spiBand === 'at_risk'
                      ? 'bg-brand-accent/10 border-brand-accent/30 text-brand-accent-dark'
                      : 'bg-semantic-critical-bg border-semantic-critical/30 text-semantic-critical',
                ].join(' ')}
                title={`Schedule Performance Index: ${spi.toFixed(2)}`}
                aria-label={`SPI ${spi.toFixed(2)} — ${spiBand === 'on_track' ? 'on track' : spiBand === 'at_risk' ? 'at risk' : 'behind schedule'}`}
              >
                <span className="tppm-mono">SPI {spi.toFixed(2)}</span>
              </span>
            </div>
          )}

          {/* CPI chip — comfortable + detailed, when showEvm includes 'cpi' and task.cpi is set (issue 185). */}
          {showCpiChip && cpi !== null && (
            <div className="mt-1">
              <span
                className={[
                  'inline-flex items-center gap-0.5 text-xs px-1 py-px rounded-chip border',
                  cpi >= 0.95
                    ? 'bg-semantic-on-track-bg border-semantic-on-track/30 text-semantic-on-track'
                    : cpi >= 0.85
                      ? 'bg-brand-accent/10 border-brand-accent/30 text-brand-accent-dark'
                      : 'bg-semantic-critical-bg border-semantic-critical/30 text-semantic-critical',
                ].join(' ')}
                title={`Cost Performance Index: ${cpi.toFixed(2)}`}
                aria-label={`CPI ${cpi.toFixed(2)} — ${cpi >= 0.95 ? 'on budget' : cpi >= 0.85 ? 'over budget' : 'significantly over budget'}`}
              >
                <span className="tppm-mono">CPI {cpi.toFixed(2)}</span>
              </span>
            </div>
          )}

          {/* Cost chip — when showCost toggle is on and task has cost data (issue 189). */}
          {showCostChip && task.budgetAtCompletion != null && (
            <div className="mt-1">
              <span
                className={[
                  'inline-flex items-center gap-0.5 text-xs px-1 py-px rounded-chip border',
                  task.actualCost != null && task.actualCost > task.budgetAtCompletion
                    ? 'bg-semantic-critical-bg border-semantic-critical/30 text-semantic-critical'
                    : 'bg-neutral-surface-sunken border-neutral-border text-neutral-text-secondary',
                ].join(' ')}
                title={`Actual cost ${task.actualCost != null ? fmtCurrency(task.actualCost) : '—'} of ${fmtCurrency(task.budgetAtCompletion)}`}
                aria-label={`Cost: ${task.actualCost != null ? fmtCurrency(task.actualCost) : 'no actuals'} of ${fmtCurrency(task.budgetAtCompletion)} budget`}
              >
                <span className="tppm-mono">
                  {task.actualCost != null ? fmtCurrency(task.actualCost) : '—'}
                  {' / '}
                  {fmtCurrency(task.budgetAtCompletion)}
                </span>
              </span>
            </div>
          )}
          {/* Baseline vs. forecast date variance (issue 186), folded into the
            issue 1305 peek so the badge's aria-controls covers everything it reveals;
            the panel inherits the peek's collapsed/revealed visibility. */}
          {baselineVarianceDays !== null && (
            <div
              className="mt-1.5 pt-1 border-t border-neutral-border/30"
              aria-label={`Baseline variance: ${baselineVarianceDays > 0 ? '+' : ''}${baselineVarianceDays}d`}
            >
              <div className="flex items-center gap-1.5 flex-wrap text-xs">
                <span className="text-neutral-text-disabled">
                  BL <span className="tppm-mono">{formatShortDate(task.baselineFinish!)}</span>
                </span>
                <span className="text-neutral-text-disabled" aria-hidden="true">
                  →
                </span>
                <span className="text-neutral-text-secondary">
                  FC <span className="tppm-mono">{formatShortDate(task.finish)}</span>
                </span>
                <span
                  className={[
                    'font-medium tppm-mono',
                    baselineVarianceDays > 5
                      ? 'text-semantic-critical'
                      : baselineVarianceDays > 0
                        ? 'text-semantic-at-risk'
                        : 'text-semantic-on-track',
                  ].join(' ')}
                >
                  {baselineVarianceDays > 0 ? '+' : ''}
                  {baselineVarianceDays}d
                </span>
              </div>
            </div>
          )}
        </div>
        {/* end health-chip peek (issue 1305) */}

        {/* 100%-complete nudge */}
        {showNudge && (
          <div className="text-xs text-brand-primary mt-1 font-medium">Move to Done?</div>
        )}
      </div>
      {/* end padding wrapper */}

      {/* A pending card shows the single-tap ✓ accept in the right-9 slot. The
          dependency/risk signal chips now live in-flow in the badge row (issue
          1735), so the top-right corner holds only the accept ✓ and the ··· menu. */}
      {acceptIcon}
      {menuButton}
    </div>
  );
}

/**
 * Memoized so an unrelated board re-render (drag-over, another card's focus,
 * chain-hover, a search keystroke) skips every card whose props are unchanged
 * (issue 1520). The default shallow prop comparison is correct here because the
 * parent now feeds only primitives (`isKeyboardFocused`, `isDimmed`), the stable
 * `task` reference, and stable task-aware callbacks — no per-card closures.
 */
export const BoardCard = memo(BoardCardImpl);
