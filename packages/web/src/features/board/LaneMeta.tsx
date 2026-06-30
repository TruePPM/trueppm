/**
 * LaneMeta — left-rail atom for each phase swimlane on the Board (issue #208).
 *
 * Anatomy (188px wide, two rows + optional cost row):
 *   ▌  Phase name                          [+]
 *   ▌  ━━━━━━━━━━━ 55%   8 tasks
 *
 * Workshop variant (`workshop={true}`): background tinted with phase color,
 * phase name becomes contentEditable, drag handle rendered (ADR-0046).
 * Escape reverts to the saved name; Enter/blur commits by calling onPhaseRename.
 *
 * The earlier ProgressRing layout was replaced in epic #361 child E
 * (issue #385) — an inline 4px bar carries the same signal in less vertical
 * real estate, and it composes cleanly with the new phase-grid quieting (empty
 * cells render as 16px ticks instead of card-shaped slots).
 */
import { type ReactNode, type KeyboardEvent, useRef, useCallback } from 'react';

export interface LaneMetaProps {
  phaseId: string;
  phaseName: string;
  /** 0–100 average progress across all tasks in this phase. */
  avgProgress: number;
  taskCount: number;
  /**
   * Count of *committed* tasks (plannedStart set or sprint-assigned). Drives
   * the em-dash empty state on the percent display: a phase whose only cards
   * are uncommitted ideas has no delivery to roll up. Falls back to taskCount
   * when omitted (backwards compat for callers that don't separate the two).
   */
  committedTaskCount?: number;
  /** Hex color for the 3px left rail; use phaseColor() helper to derive. */
  railColor: string;
  /** Workshop mode: tinted bg, editable name, drag handle. */
  workshop?: boolean;
  /** Called when the user commits a phase rename in workshop mode. */
  onPhaseRename?: (newName: string) => void;
  /**
   * @dnd-kit listeners for the drag handle in workshop mode. When provided, the
   * ⋮⋮ handle activates the sortable drag for phase reordering.
   */
  dragHandleListeners?: Record<string, unknown>;
  onAddTask?: () => void;
  /**
   * Override for the "+" button's title and aria-label. Defaults to
   * `Add task to ${phaseName}`. The synthetic phase-less Project Tasks lane
   * (#387) sets this to `Add to backlog` so the affordance signals where
   * the new task is actually going — that lane is intake scaffolding, not
   * a real committed structure.
   */
  addTaskLabel?: string;
  /** Expand/collapse toggle rendered inside the phase name row. */
  collapseToggle?: ReactNode;
  /** Phase-lane focus toggle (#1460) rendered next to the add-task action. */
  focusToggle?: ReactNode;
  /** When true, show cost row (issue #189). */
  showCost?: boolean;
  /** Sum of task.budgetAtCompletion for all tasks in this phase. */
  phaseBudgetAtCompletion?: number | null;
  /** Sum of task.actualCost for tasks that have actual cost data. */
  phaseActualCost?: number | null;
}

function fmtCurrencyLane(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}

export function LaneMeta({
  phaseId,
  phaseName,
  avgProgress,
  taskCount,
  committedTaskCount,
  railColor,
  workshop = false,
  onPhaseRename,
  dragHandleListeners,
  onAddTask,
  addTaskLabel,
  collapseToggle,
  focusToggle,
  showCost = false,
  phaseBudgetAtCompletion = null,
  phaseActualCost = null,
}: LaneMetaProps) {
  const pct = Math.max(0, Math.min(100, avgProgress));
  const editableRef = useRef<HTMLSpanElement>(null);

  const handleBlur = useCallback(() => {
    if (!editableRef.current || !onPhaseRename) return;
    const newName = editableRef.current.textContent?.trim() ?? '';
    if (newName && newName !== phaseName) {
      onPhaseRename(newName);
    } else {
      // Revert if empty or unchanged
      editableRef.current.textContent = phaseName;
    }
  }, [phaseName, onPhaseRename]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLSpanElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        editableRef.current?.blur();
      } else if (e.key === 'Escape') {
        if (editableRef.current) {
          editableRef.current.textContent = phaseName;
        }
        editableRef.current?.blur();
      }
    },
    [phaseName],
  );

  // No committed tasks → bar empty, percent reads as em-dash (ADR-0057).
  // Below 50% the fill is brand-accent (in-flight signal); at/above 50% it
  // shifts to semantic-on-track (closing in on done). Mirrors the prior ring.
  // committedTaskCount distinguishes "has cards but none committed" (idea
  // inbox) from "has committed delivery"; legacy callers that pass only
  // taskCount fall through to the prior behavior.
  const hasCommitted = (committedTaskCount ?? taskCount) > 0;
  const fillClass = !hasCommitted
    ? 'bg-transparent'
    : pct >= 50
      ? 'bg-semantic-on-track'
      : 'bg-brand-accent';

  return (
    <div
      className="relative"
      style={workshop ? { background: `color-mix(in srgb, ${railColor} 5%, var(--neutral-surface, white))` } : undefined}
    >
      {/* 3px color rail */}
      <div
        aria-hidden="true"
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{ background: railColor }}
      />

      {/* Content — inset from rail */}
      <div className="pl-[11px] pr-[14px] pt-[14px] pb-[14px] flex flex-col gap-2">

        {/* Header row: name + add button */}
        <div className="flex items-center gap-2 min-w-0">
          {workshop && (
            <span
              aria-hidden="true"
              className="text-neutral-text-disabled text-sm cursor-grab select-none flex-shrink-0"
              title="Drag to reorder phase"
              {...(dragHandleListeners as Record<string, (e: unknown) => void>)}
            >
              ⋮⋮
            </span>
          )}

          {collapseToggle}

          {workshop ? (
            <span
              ref={editableRef}
              role="textbox"
              tabIndex={0}
              contentEditable
              suppressContentEditableWarning
              aria-label={`Phase name: ${phaseName}`}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="flex-1 text-xs font-semibold text-neutral-text-primary
                outline-none border border-dashed border-neutral-border rounded-control px-[6px] py-[3px]
                bg-neutral-surface focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              {phaseName}
            </span>
          ) : (
            <span className="flex-1 text-xs font-semibold text-neutral-text-primary truncate">
              {phaseName}
            </span>
          )}

          {/* The add-task affordance is phase-authoring: it parents a new task
              under this lane's summary. Assignee-grouped lanes (324) pass no
              onAddTask — a lane id there is a resource, not a parent — so the
              button is suppressed rather than rendered dead. */}
          {onAddTask && (
            <button
              type="button"
              onClick={onAddTask}
              title={addTaskLabel ?? `Add task to ${phaseName}`}
              aria-label={addTaskLabel ?? `Add task to ${phaseName}`}
              data-testid={`add-task-${phaseId}`}
              className="flex-shrink-0 w-[22px] h-[22px] flex items-center justify-center rounded-control
                border border-neutral-border bg-neutral-surface text-neutral-text-secondary
                hover:border-brand-primary/50 hover:text-brand-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <svg aria-hidden="true" width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                <line x1="5" y1="1" x2="5" y2="9" />
                <line x1="1" y1="5" x2="9" y2="5" />
              </svg>
            </button>
          )}

          {/* Phase-lane focus toggle (#1460) — sits with the lane-authoring
              actions so "zoom to this lane" reads as a lane-scoped control. */}
          {focusToggle}
        </div>

        {/* Progress row — 4px inline bar + mono percent + task count.
            Em-dash empty state when no committed tasks (ADR-0057). After
            BACKLOG was lifted into the band above the grid, a phase whose
            only cards are backlog ideas has zero committed delivery.
            "0%" would imply "0% done"; "—" reads as "not applicable yet". */}
        <div className="flex items-center gap-2 min-w-0">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={hasCommitted ? pct : undefined}
            aria-label={
              hasCommitted ? `Phase progress ${pct} percent` : 'No committed tasks'
            }
            className="flex-1 h-1 rounded-full bg-neutral-surface-sunken overflow-hidden"
          >
            <div
              aria-hidden="true"
              className={`h-full ${fillClass} transition-[width] duration-150`}
              style={{ width: hasCommitted ? `${pct}%` : 0 }}
            />
          </div>
          <span
            className="tppm-mono text-xs font-semibold text-neutral-text-primary leading-none flex-shrink-0"
          >
            {hasCommitted ? `${pct}%` : '—'}
          </span>
          <span className="text-xs text-neutral-text-secondary leading-none flex-shrink-0">
            {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
          </span>
        </div>

        {/* Cost row — shown when showCost toggle is on and phase has budget data (issue #189). */}
        {showCost && phaseBudgetAtCompletion != null && (
          <div
            className="flex items-center gap-1 flex-wrap text-xs"
            aria-label={`Phase budget: ${phaseActualCost != null ? fmtCurrencyLane(phaseActualCost) : 'no actuals'} of ${fmtCurrencyLane(phaseBudgetAtCompletion)}`}
          >
            <span
              className={[
                'tppm-mono',
                phaseActualCost != null && phaseActualCost > phaseBudgetAtCompletion
                  ? 'text-semantic-critical font-medium'
                  : 'text-neutral-text-secondary',
              ].join(' ')}
            >
              {phaseActualCost != null ? fmtCurrencyLane(phaseActualCost) : '—'}
            </span>
            <span className="text-neutral-text-disabled">/</span>
            <span className="tppm-mono text-neutral-text-secondary">
              {fmtCurrencyLane(phaseBudgetAtCompletion)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
