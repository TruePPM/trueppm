import type { Task, TaskStatus } from '@/types';
import type { ProjectCustomField } from '@/hooks/useProjectCustomFields';

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

/** A board column as the card needs it: status key, label, and optional dwell SLA. */
export interface BoardCardColumn {
  status: TaskStatus;
  label: string;
  slaDays?: number;
  /**
   * Named lane this track represents (#2967), or null/absent when the track is
   * the whole status column. Present so a card in a laned column can name the
   * lane it actually sits in rather than the column's first one.
   */
  laneKey?: string | null;
  /** The owning column's label — the lane label alone is not a location. */
  columnLabel?: string;
}

export interface BoardCardProps {
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
  columns: BoardCardColumn[];
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
  /**
   * Whether the readiness chip carries signal on this board (#2430). Decided
   * board-wide by `readinessIsInformative` and applied upstream — BoardView
   * passes `false` when every visible card shares one readiness value, so the
   * card stays unaware of board-view state (same contract as
   * {@link BoardCardProps.customFieldDefs}).
   *
   * Defaults to `true` for callers with no board context (the drag overlay,
   * standalone renders) — the chip's own `task.readiness` guard still applies.
   */
  showReadiness?: boolean;
}
