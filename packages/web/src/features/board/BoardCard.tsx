import {
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
import { isTaskScheduled } from '@/lib/task';
import { PendingAcceptanceChip } from './PendingAcceptanceChip';
import { ReadinessChip } from './ReadinessChip';
import { TypeBadge } from '@/features/project/backlog/components/TypeBadge';

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

/** Which EVM performance indicators to show on cards (issue #185). */
export type EvmMode = 'spi' | 'cpi' | 'both' | 'off';

interface BoardCardProps {
  task: Task;
  isOverlay?: boolean;
  isStalled?: boolean;
  onMenuMove: (newStatus: TaskStatus) => void;
  columns: { status: TaskStatus; label: string; slaDays?: number }[];
  density?: BoardDensity;
  /**
   * Per-assignee peak overallocation factor (resourceId → factor > 1.0).
   * Source: useBoardOverallocation. Optional; absent on the drag overlay.
   */
  overallocByResource?: Map<string, number>;
  /** True when this card is the keyboard-focused card (issue #195). */
  isKeyboardFocused?: boolean;
  /** True when card should dim because it's not in the active dep highlight set (issue #182). */
  isDimmed?: boolean;
  /** Click handlers for chain / risk icons (issue #182, #188). */
  onShowDeps?: () => void;
  onShowRisks?: () => void;
  /** Hover handlers for chain icon — drives board-level "dim non-connected" state. */
  onChainHoverEnter?: () => void;
  onChainHoverLeave?: () => void;
  /** Which EVM indicators to show (issue #185). Default 'off'. */
  showEvm?: EvmMode;
  /** When true, show budget/cost chips when task has cost data (issue #189). */
  showCost?: boolean;
  /**
   * Card click handler (issue #304). Fires on the root only when no child
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
   * Closed-sprint read-only (#1141). When true, drag-to-assign is disabled:
   * `useDraggable` is disabled (no listeners) and the cursor is default — but
   * click-to-open and scroll still work, because reading a closed sprint's board
   * is the use case. The card is NOT marked `aria-disabled` (it stays a usable
   * button for opening detail); the ClosedSprintBanner announces the read-only state.
   */
  readOnly?: boolean;
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
 * Returns daysAgo for use by the SLA aging indicator (issue #192).
 */
function entryStamp(task: Task): { text: string; isStalled: boolean; daysAgo: number | null } {
  if (!task.statusEnteredAt) {
    return { text: '', isStalled: false, daysAgo: null };
  }

  // dwell + the stalled verdict are server-owned (#992, ADR-0115): the API returns
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

// Left accent bar color per readiness state (issue #179).
// CP (critical) overrides all; at-risk overrides estimated/ready/baselined.
// `showCriticalState` gates the red CP override so backlog/uncommitted tasks
// don't display scheduled-state styling (issue #332).
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

/** Tooltip text for a critical-path task (issue #181 / WCAG 1.4.1). */
function cpTooltip(_task: Task): string {
  return 'On critical path — any delay here will delay the project end date';
}

// Risk icon color band: maps the 5-tier severity register down to a 3-tier
// RAG palette for icon-scale display (ADR-0035 §Q2).  Full 5-tier breakdown
// is shown inside the RiskPopover for color-blind safety.
function riskIconClass(severity: number | null | undefined): string {
  const band = severityRagBand(severity);
  switch (band) {
    case 'red':
      return 'text-semantic-critical';
    case 'amber':
      return 'text-brand-accent-dark dark:text-brand-accent';
    case 'green':
      return 'text-semantic-on-track';
    default:
      return 'text-neutral-text-disabled';
  }
}

export function BoardCard({
  task,
  isOverlay,
  isStalled: isOverrideStalled,
  onMenuMove,
  columns,
  density = 'comfortable',
  overallocByResource,
  isKeyboardFocused = false,
  isDimmed = false,
  onShowDeps,
  onShowRisks,
  onChainHoverEnter,
  onChainHoverLeave,
  showEvm = 'off',
  showCost = false,
  onCardClick,
  scopeActions,
  readOnly = false,
}: BoardCardProps) {
  // A closed-sprint board disables drag-to-assign (#1141): dnd-kit returns empty
  // listeners/attributes when disabled, so the card keeps click-to-open + scroll
  // but can never be dragged into the closed sprint's scope.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled: readOnly,
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // #838: roving-focus keyboard nav for the overflow menu + submenu.
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
  // restores focus to the ··· trigger (WCAG 2.1.1 menu pattern, #838).
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

  const otherColumns = columns.filter((c) => c.status !== task.status);
  const { text: stampText, isStalled: derivedStalled, daysAgo } = entryStamp(task);
  const isStalled = isOverrideStalled ?? derivedStalled;
  // COMPLETE clamps display progress to 100% so the ring, the bottom strip,
  // and the aria-label all reflect "done" regardless of the stored value.
  // The raw `task.progress` is still used for SPI math (line 133) since SPI
  // measures actual delivered work against plan, not status.
  const effectiveProgress = task.status === 'COMPLETE' ? 100 : task.progress;

  // Aging / dwell-time indicator (issue #192)
  const slaDays = columns.find((c) => c.status === task.status)?.slaDays;
  const isAging = daysAgo !== null && slaDays !== undefined && daysAgo > slaDays;
  const isPastTwiceSla = isAging && daysAgo > 2 * slaDays;
  const isIdea = (task.readiness ?? 'estimated') === 'idea';
  const isCompact = density === 'compact';
  const isDetailed = density === 'detailed';

  // CPM marks every dated task with isCritical/totalFloat, including backlog
  // ideas the PM hasn't committed to. Suppress the red CP signal and float
  // chip until the task is scheduled (plannedStart set or in a sprint) — see
  // issue #332. The CPM data is still passed through unchanged; only the
  // display gates on commitment.
  const isScheduled = isTaskScheduled(task);

  // ADR-0102: a pending-acceptance injection is visible but not yet committed.
  // The card is muted and — per the ux-design — the red CP signal is suppressed
  // while pending (the task isn't part of the commitment, so its critical-path
  // status is not yet a team concern; it reappears on accept). The neutral
  // PendingAcceptanceChip carries the read-state instead.
  const isPending = task.sprintPending === true;
  const showCriticalState = task.isCritical && isScheduled && !isPending;

  // EVM indicators (issue #185): SPI + its band are server-owned (#990 / API-first
  // #986) — the card renders them, it no longer re-derives earned%/planned% from
  // baseline dates in the browser. CPI stays sourced from the (currently unpopulated)
  // cost field until the cost model ships (#73).
  const spi = task.spi ?? null;
  const spiBand = task.spiBand ?? null;
  const cpi = task.cpi ?? null;
  const showSpiChip =
    !isCompact && showEvm !== 'off' && (showEvm === 'spi' || showEvm === 'both') && spi !== null;
  const showCpiChip =
    !isCompact && showEvm !== 'off' && (showEvm === 'cpi' || showEvm === 'both') && cpi !== null;

  // Cost chip (issue #189): shown when toggle is on and task has BAC data.
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

  const signalIcons =
    showChain || showRisk ? (
      <div
        className={[
          'absolute top-2 right-9 flex items-center gap-1',
          density === 'compact' ? 'top-[7px]' : '',
        ].join(' ')}
      >
        {showChain && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onShowDeps?.();
            }}
            onPointerEnter={onChainHoverEnter}
            onPointerLeave={onChainHoverLeave}
            onFocus={onChainHoverEnter}
            onBlur={onChainHoverLeave}
            className={[
              'relative w-5 h-5 inline-flex items-center justify-center rounded-control text-xs',
              'before:absolute before:inset-[-12px]',
              'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              'focus-visible:outline-none',
              isBlocked ? 'text-semantic-critical' : 'text-neutral-text-secondary',
              'hover:bg-neutral-surface-raised',
            ].join(' ')}
            aria-label={
              isBlocked
                ? `Blocked by ${predecessorCount} ${predecessorCount === 1 ? 'dependency' : 'dependencies'}. Press D to view.`
                : `${predecessorCount} ${predecessorCount === 1 ? 'dependency' : 'dependencies'}. Press D to view.`
            }
          >
            <span aria-hidden="true">🔗</span>
            {density === 'detailed' && predecessorCount > 1 && (
              <span className="absolute -bottom-1 -right-1 text-xs tppm-mono leading-none px-0.5 rounded-chip bg-neutral-surface border border-neutral-border">
                {predecessorCount}
              </span>
            )}
          </button>
        )}
        {showRisk && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onShowRisks?.();
            }}
            className={[
              'relative w-5 h-5 inline-flex items-center justify-center rounded-control text-xs',
              'before:absolute before:inset-[-12px]',
              'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
              'focus-visible:outline-none',
              riskIconClass(linkedRisksMaxSeverity),
              'hover:bg-neutral-surface-raised',
            ].join(' ')}
            aria-label={
              `${linkedRisksCount} linked risk${linkedRisksCount === 1 ? '' : 's'}, ` +
              `severity ${severityRagBand(linkedRisksMaxSeverity) ?? 'low'}. Click to view.`
            }
          >
            <span aria-hidden="true">⚠</span>
            {linkedRisksCount > 1 && (
              <span className="absolute -top-1 -right-1 text-xs tppm-mono leading-none px-0.5 rounded-chip bg-neutral-surface border border-neutral-border">
                {linkedRisksCount}
              </span>
            )}
          </button>
        )}
      </div>
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
          hover:bg-neutral-surface-raised opacity-0 group-hover:opacity-100
          focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1"
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
                focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-inset"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                setMoveOpen(false);
                scopeActions.onReject(task);
              }}
            >
              Reject from sprint
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="w-full text-left px-3 py-2 text-sm text-neutral-text-primary
              hover:bg-neutral-surface-raised
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
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
                    focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMenuMove(col.status);
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
        aria-label={`Accept ${task.name} into the sprint`}
        title="Accept into the sprint"
        className="absolute top-2 right-9 w-6 h-6 flex items-center justify-center rounded-control
          text-brand-primary hover:bg-brand-primary/10
          before:absolute before:inset-[-10px] before:content-['']
          focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-brand-primary
          focus-visible:ring-offset-1 focus-visible:outline-none"
      >
        <span aria-hidden="true">✓</span>
      </button>
    ) : null;

  // Shared card container class. A read-only (closed-sprint) card drops the
  // grab cursor — it's still clickable to open detail, just not draggable (#1141).
  const containerClass = [
    'bg-neutral-surface border rounded-card relative group',
    readOnly ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
    'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
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
    isDimmed ? 'opacity-40' : '',
    // Pending injections are de-emphasized (ADR-0102 §6) — but not as faint as
    // a dimmed/dep-highlight card, so the chip + accept tick stay legible.
    isPending && !isDimmed ? 'opacity-70' : '',
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

  // Compact density — title + CP chip + progress strip, ~36px (issue #193)
  if (isCompact) {
    const progressColor = showCriticalState
      ? 'bg-semantic-critical'
      : effectiveProgress === 100
        ? 'bg-semantic-on-track'
        : 'bg-brand-primary';
    return (
      <div
        ref={measureCardRef}
        {...listeners}
        {...attributes}
        onClick={(e) => onCardClick?.(task, e.currentTarget)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && e.currentTarget === e.target) {
            e.preventDefault();
            onCardClick?.(task, e.currentTarget);
          }
        }}
        className={containerClass}
        role="button"
        tabIndex={0}
        aria-label={`${task.name}, ${effectiveProgress}% complete${showCriticalState ? ', critical path' : ''}`}
      >
        <div
          className={`absolute left-0 inset-y-0 w-1 rounded-l-md ${accentBarClass(task, showCriticalState)}`}
          aria-hidden="true"
        />
        <div className="pl-2.5 pr-8 py-2 flex items-center gap-1 min-w-0">
          <span
            className={[
              'text-xs font-medium truncate flex-1 min-w-0',
              showCriticalState
                ? 'text-semantic-critical font-semibold'
                : isIdea
                  ? 'text-neutral-text-disabled italic'
                  : 'text-neutral-text-primary',
            ].join(' ')}
            title={showCriticalState ? cpTooltip(task) : undefined}
          >
            {task.name}
          </span>
          {isPending && <PendingAcceptanceChip compact className="shrink-0" />}
          {showCriticalState && (
            <span
              className="shrink-0 inline-block px-1 py-px rounded-chip text-xs text-white bg-semantic-critical font-bold"
              aria-hidden="true"
            >
              CP
            </span>
          )}
        </div>
        {/* 3px progress strip at the bottom of each compact card */}
        <div
          className="absolute bottom-0 left-1 right-1 h-[3px] rounded-full overflow-hidden bg-neutral-border"
          aria-hidden="true"
        >
          <div className={`h-full ${progressColor}`} style={{ width: `${effectiveProgress}%` }} />
        </div>
        {acceptIcon ?? signalIcons}
        {menuButton}
      </div>
    );
  }

  // Comfortable and Detailed density
  const showNudge = task.progress === 100 && task.status !== 'COMPLETE';
  // In detailed mode show all assignees; comfortable caps at 3
  const visibleAssignees = isDetailed ? task.assignees : task.assignees.slice(0, 3);
  const hiddenCount = isDetailed ? 0 : Math.max(0, task.assignees.length - 3);

  // Float chip (issue #183): CP tasks have 0d float by definition; non-CP shows totalFloat when set.
  // Suppressed entirely on unscheduled tasks — CPM produces float for every dated task,
  // including backlog ideas, so reading totalFloat without an isScheduled gate is the bug
  // behind issue #332.
  const hasFloatData =
    isScheduled && (task.isCritical || (task.totalFloat !== undefined && task.totalFloat !== null));
  const floatDays = task.isCritical ? 0 : (task.totalFloat as number);

  // Baseline variance hover panel (issue #186): calendar days between forecast finish and baseline.
  // Positive = late. Shown only when baselineFinish is present.
  const baselineVarianceDays: number | null = task.baselineFinish
    ? Math.round(
        (new Date(task.finish).getTime() - new Date(task.baselineFinish).getTime()) / 86_400_000,
      )
    : null;

  return (
    <div
      ref={measureCardRef}
      {...listeners}
      {...attributes}
      onClick={(e) => onCardClick?.(task, e.currentTarget)}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.currentTarget === e.target) {
          e.preventDefault();
          onCardClick?.(task, e.currentTarget);
        }
      }}
      className={containerClass}
      role="button"
      tabIndex={0}
      aria-label={`${task.name}, ${effectiveProgress}% complete${showCriticalState ? ', critical path' : ''}`}
    >
      {/* Left accent bar — rounded-l-md matches card's border-radius so the bar
          respects the card corners without needing overflow-hidden on the parent. */}
      <div
        className={`absolute left-0 inset-y-0 w-1 rounded-l-md ${accentBarClass(task, showCriticalState)}`}
        aria-hidden="true"
      />

      {/* Card content — left-padded to clear the accent bar */}
      <div className="pl-2.5 pr-2.5 pt-2.5 pb-2.5">
        {/* Readiness chip — top-left (issue #179) */}
        {task.readiness && (
          <div className="mb-1.5">
            <ReadinessChip readiness={task.readiness} />
          </div>
        )}

        {/* Tech-debt badge (ADR-0135, #1076) — debt is the one type surfaced on
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
              'text-xs font-medium truncate min-w-0',
              showCriticalState
                ? 'text-semantic-critical font-semibold'
                : isIdea
                  ? 'text-neutral-text-disabled italic'
                  : 'text-neutral-text-primary',
            ].join(' ')}
            title={showCriticalState ? cpTooltip(task) : undefined}
          >
            {task.name}
          </span>
        </div>

        {/* Badge row — CP, pending-acceptance chip, assignee initials */}
        {(showCriticalState || isPending || task.assignees.length > 0 || isIdea) && (
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            {isPending && <PendingAcceptanceChip />}
            {showCriticalState && (
              <span
                className="inline-block px-1 py-px rounded-chip text-xs text-white bg-semantic-critical font-bold"
                aria-hidden="true"
              >
                CP
              </span>
            )}
            {isIdea ? (
              <span
                className="inline-block w-5 h-5 rounded-full border border-dashed border-neutral-border
                  flex items-center justify-center text-xs text-neutral-text-disabled"
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
                        className="inline-block px-1 py-px rounded-chip text-xs text-white bg-brand-primary font-bold"
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
                    className="inline-block px-1 py-px rounded-chip text-xs text-white bg-brand-primary font-bold"
                    aria-hidden="true"
                  >
                    +{hiddenCount}
                  </span>
                )}
              </>
            )}
          </div>
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

        {/* Aging / dwell-time indicator (issue #192): shown when dwell > column SLA. */}
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
            <span aria-hidden="true">⏱</span>
            <span className="tppm-mono">{daysAgo}d</span>
          </div>
        )}

        {/* Float chip — comfortable + detailed, when CPM data is present (issue #183).
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
              {floatDays < 0 && <span aria-hidden="true">⚠</span>}
              <span className="tppm-mono">{floatDays}d float</span>
            </span>
          </div>
        )}

        {/* SPI chip — comfortable + detailed, when showEvm includes 'spi' (issue #185 / #990).
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

        {/* CPI chip — comfortable + detailed, when showEvm includes 'cpi' and task.cpi is set (issue #185). */}
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

        {/* Cost chip — when showCost toggle is on and task has cost data (issue #189). */}
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

        {/* Baseline vs. forecast date variance — hover/focus panel (issue #186).
            Hidden by default; revealed on group-hover or group-focus-within. */}
        {baselineVarianceDays !== null && (
          <div
            className="hidden group-hover:block group-focus-within:block mt-1.5 pt-1 border-t border-neutral-border/30"
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

        {/* 100%-complete nudge */}
        {showNudge && (
          <div className="text-xs text-brand-primary mt-1 font-medium">Move to Done?</div>
        )}
      </div>
      {/* end padding wrapper */}

      {/* A pending card shows the single-tap ✓ accept in the right-9 slot;
          its signal icons (chain/risk) are suppressed there to avoid overlap
          (they remain reachable via the card detail). */}
      {acceptIcon ?? signalIcons}
      {menuButton}
    </div>
  );
}
