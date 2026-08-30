/**
 * LaneMeta — left-rail atom for each phase swimlane on the Board (issue 208).
 *
 * Anatomy (188px wide, two rows + optional cost row):
 *   ▌  Phase name                          [+]
 *   ▌  ━━━━━━━━━━━━━━━━━━   8 tasks
 *
 * Workshop variant (`workshop={true}`): background tinted with phase color,
 * phase name becomes contentEditable, drag handle rendered (ADR-0046).
 * Escape reverts to the saved name; Enter/blur commits by calling onPhaseRename.
 *
 * The earlier ProgressRing layout was replaced in epic #361 child E
 * (issue #385) — an inline bar carries the same signal in less vertical real
 * estate, and it composes cleanly with the phase-grid quieting (empty cells
 * render as 16px ticks instead of card-shaped slots). #1965 thickened the bar
 * to h-1.5 (glanceable color mass) and moved the fill to the neutral sage
 * brand-primary, so progress amount is no longer painted with health colors.
 *
 * #3148 removed the numeral that used to sit beside the bar. The header carried
 * one proportion through two channels — a track drawn at `55%` and the string
 * "55%" — and a lane header is a glance surface answering *which phase is
 * behind*, not *by how much*. The bar survived the cut on three grounds the
 * numeral did not meet: it is already the accessible surface, it is the only
 * channel that reads as a column when six lanes stack, and it costs no
 * horizontal room in a 188px cell that also holds a name, a count and a `+`.
 * The percentage moved to the accessible name and to a hover/focus tooltip.
 */
import { type ReactNode, type KeyboardEvent, useRef, useCallback } from 'react';

import { Tooltip } from '@/components/Tooltip';

export interface LaneMetaProps {
  phaseId: string;
  phaseName: string;
  /** 0–100 average progress across all tasks in this phase. */
  avgProgress: number;
  taskCount: number;
  /**
   * Count of *committed* tasks (plannedStart set or sprint-assigned). This is
   * the sole gate on the progress slot: above zero the slot draws a bar, at
   * zero it draws an em-dash and no `progressbar` element at all, because a
   * phase whose only cards are uncommitted ideas has no delivery to roll up.
   *
   * Omitting it means **zero**, not `taskCount`. The old fallback answered
   * "does this lane hold cards?" when the question the slot asks is "does this
   * lane hold committed work?" — two different facts that only coincide on a
   * fully-scheduled phase, so a caller that does not distinguish them cannot
   * be assumed to have committed work (#3148).
   */
  committedTaskCount?: number;
  /**
   * Hex color for the 3px left rail; use phaseColor() helper to derive. An
   * uncommitted lane overrides it with a neutral (see the rail below): "nothing
   * measurable here" is carried by the rail as well as by the slot.
   */
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
  /**
   * @dnd-kit sortable attributes (role, tabIndex, aria-*) for the drag handle in
   * workshop mode. These belong on the real ⋮⋮ handle button — not on the lane
   * wrapper, which would turn the whole swimlane into one giant role="button" and
   * leave the actual handle keyboard/SR-inert (#2201).
   */
  dragHandleAttributes?: Record<string, unknown>;
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
  /** Phase-lane focus toggle (issue 1460) rendered next to the add-task action. */
  focusToggle?: ReactNode;
  /** When true, show cost row (issue #189). */
  showCost?: boolean;
  /** Sum of task.budgetAtCompletion for all tasks in this phase. */
  phaseBudgetAtCompletion?: number | null;
  /** Sum of task.actualCost for tasks that have actual cost data. */
  phaseActualCost?: number | null;
}

/**
 * The uncommitted slot's accessible name. Named once because it is asserted in
 * three test layers and drifting it silently would leave the tab stop unnamed.
 */
const NO_PROGRESS_LABEL =
  'Phase progress: not applicable — no committed work in this phase';

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
  dragHandleAttributes,
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

  // The one gate on the progress slot. `committedTaskCount` distinguishes "has
  // cards but none committed" (an idea inbox) from "has committed delivery";
  // omitting it means zero, never taskCount — see the prop docblock (#3148).
  const committed = committedTaskCount ?? 0;
  const measurable = committed > 0;

  const taskWord = taskCount === 1 ? 'task' : 'tasks';

  // The percentage the visible row no longer carries. Three carriers, so no
  // fact lives only in a tooltip: hover for a sighted pointer user, focus for a
  // sighted keyboard user, and the slot's accessible name for a screen reader.
  //
  // Touch is deliberately NOT one of them. The slot is a 6px-tall readout, not
  // a control, and it is nowhere near rule 5's 44px floor — expanding it to
  // reach that floor would drive its hit box into the `+` button's own
  // expander 8px above and break a working affordance to serve a redundant
  // one. `Tooltip` does tap-toggle, so a touch user who lands on it gets the
  // string, but the guaranteed coarse-pointer path is the one the design
  // specifies: tapping the lane name opens the phase, which states progress in
  // full. Do not add a touch expander here without moving the `+` first.
  const progressTip = `${pct}% complete · ${committed} of ${taskCount} ${taskWord} committed`;
  const noProgressTip =
    taskCount === 0
      ? 'No tasks in this phase yet'
      : `No committed work yet — ${taskCount} uncommitted ${taskWord}`;

  return (
    <div
      className="relative"
      style={workshop ? { background: `color-mix(in srgb, ${railColor} 5%, var(--neutral-surface, white))` } : undefined}
    >
      {/* 3px color rail. An uncommitted lane drops the phase accent for a
          neutral so the "nothing measurable here" state is legible from the
          rail alone, at the scale where a stack of lanes is scanned rather
          than read (#3148). The token is the inert-affordance neutral, which
          is what this rail now is — it is decorative (aria-hidden) and the
          slot beside it carries the claim in words. */}
      <div
        aria-hidden="true"
        className={`absolute left-0 top-0 bottom-0 w-[3px] ${
          measurable ? '' : 'bg-neutral-text-disabled'
        }`}
        style={measurable ? { background: railColor } : undefined}
      />

      {/* Content — inset from rail */}
      <div className="pl-[11px] pr-[14px] pt-[14px] pb-[14px] flex flex-col gap-2">

        {/* Header row: name + add button */}
        <div className="flex items-center gap-2 min-w-0">
          {workshop && (
            <button
              type="button"
              aria-label={`Reorder phase: ${phaseName}`}
              className="text-neutral-text-disabled text-sm cursor-grab active:cursor-grabbing select-none flex-shrink-0"
              title="Drag to reorder phase"
              {...(dragHandleAttributes as Record<string, unknown>)}
              {...(dragHandleListeners as Record<string, (e: unknown) => void>)}
            >
              ⋮⋮
            </button>
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
              // 22px visual control + invisible expander to the 44px touch
              // target (rule 5), matching the focusToggle sibling.
              className="relative flex-shrink-0 w-[22px] h-[22px] flex items-center justify-center rounded-control
                border border-neutral-border bg-neutral-surface text-neutral-text-secondary
                hover:border-brand-primary/50 hover:text-brand-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                before:absolute before:inset-[-11px] before:content-['']"
            >
              <svg aria-hidden="true" width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                <line x1="5" y1="1" x2="5" y2="9" />
                <line x1="1" y1="5" x2="9" y2="5" />
              </svg>
            </button>
          )}

          {/* Phase-lane focus toggle (issue 1460) — sits with the lane-authoring
              actions so "zoom to this lane" reads as a lane-scoped control. */}
          {focusToggle}
        </div>

        {/* Progress row — one slot + the task count.
            The slot renders a proportion as a bar, or the absence of one as an
            em-dash. Never both, never neither, and nothing else in this header
            draws a bar (#3148 D1/D4). The count beside it is a different fact
            (how much work is here, not how far along it is) and stays.

            Height is h-1.5 (matches TaskRow) so the sage fill carries enough
            color mass to read across a rail of lanes at a glance (#1965), and
            progress magnitude uses the neutral brand-primary (sage) fill, NOT
            the semantic health palette — green/amber/red are the health
            vocabulary (web-rule 7), and the pre-#385/#1965 amber-below-50 →
            green-above-50 flip made an early-but-healthy lane read "at risk". */}
        <div className="flex items-center gap-2 min-w-0">
          {measurable ? (
            <Tooltip content={progressTip}>
              {/* tabIndex is load-bearing, not decoration: with the numeral gone
                  the tooltip is the only sighted carrier of the percentage, and
                  a coarse pointer has no hover. The tab stop is what gives a
                  keyboard user the same route a mouse user gets. */}
              <div
                role="progressbar"
                tabIndex={0}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-label={`Phase progress: ${pct}% complete`}
                className={[
                  'flex-1 h-1.5 rounded-full bg-neutral-surface-sunken overflow-hidden',
                  // Standalone tooltip trigger → `focus:`, not `focus-visible:`
                  // (web-rule 4 carve-out / rule 214).
                  'focus:outline-none focus:ring-2 focus:ring-brand-primary',
                  'focus:ring-offset-1 focus:ring-offset-neutral-surface',
                  // 100% is told by FORM, not by a numeral: a full track and a
                  // 97% track are four pixels apart, which is not a difference
                  // anyone reads at a glance. The detached hairline makes
                  // "finished" a different shape rather than a slightly longer
                  // one (D3).
                  //
                  // It is an `outline`, not a `ring`, for two reasons the design
                  // handoff's `ring-1` spelling did not account for. (1) `ring-*`
                  // is a box-shadow, so `focus:ring-2` REPLACES it — a focused
                  // 100% bar and a focused 97% bar would render identically, and
                  // the state would vanish at exactly the moment a keyboard user
                  // inspected it. `outline` is a separate channel and composes.
                  // (2) A resting `ring-brand-primary` already means "selected"
                  // everywhere else in this tree (label swatches, drop targets,
                  // the cell in edit), so a finished lane would wear what reads
                  // as a selection mark permanently.
                  pct === 100
                    ? 'outline outline-1 outline-offset-[1.5px] outline-brand-primary'
                    : '',
                ].join(' ')}
              >
                <div
                  aria-hidden="true"
                  className="h-full bg-brand-primary transition-[width] duration-150"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </Tooltip>
          ) : (
            <Tooltip content={noProgressTip}>
              {/* No `progressbar` element at all — "indeterminate" is a claim
                  that work is underway with the extent unknown, and these
                  phases are not underway. An empty track and a 0% track are the
                  same picture, and both assert "measured, none done"; the
                  em-dash asserts "not applicable yet" (ADR-0057). The glyph is
                  aria-hidden because a lone dash names nothing — the sibling
                  sr-only line is what a screen reader gets, and it is also the
                  slot's accessible name for the keyboard path. */}
              {/* `role="img"` + `aria-label`, NOT a bare span wrapping sr-only
                  text: a `<span tabIndex={0}>` computes to role `generic`, which
                  does not support name-from-content, so descendant text is not
                  an accessible name and the tab stop would announce as blank.
                  axe cannot catch that — `focus-order-semantics` is tagged
                  best-practice and our scan runs wcag2a/2aa/21a/21aa only — so
                  the green a11y spec is evidence about the tag set, not the
                  markup. `img` makes the glyph presentational, which is why
                  there is no sr-only sibling to double-read.

                  The tab stop itself is required: rule 287's first invariant is
                  that an explanation is reachable by more than one input path,
                  and without it the sighted keyboard user is the one person who
                  cannot find out why this lane has no bar. */}
              <span
                role="img"
                aria-label={NO_PROGRESS_LABEL}
                tabIndex={0} // eslint-disable-line jsx-a11y/no-noninteractive-tabindex -- see the comment above: a Tooltip trigger needs a keyboard path
                className="flex-1 flex items-center leading-none rounded-control
                  focus:outline-none focus:ring-2 focus:ring-brand-primary
                  focus:ring-offset-1 focus:ring-offset-neutral-surface"
              >
                <span
                  aria-hidden="true"
                  className="tppm-mono text-xs font-semibold text-neutral-text-secondary"
                >
                  —
                </span>
              </span>
            </Tooltip>
          )}
          <span className="text-xs text-neutral-text-secondary leading-none flex-shrink-0">
            {taskCount} {taskWord}
          </span>
        </div>

        {/* Cost row — shown when showCost toggle is on and phase has budget data (issue #189).
            Numerals only, and deliberately so: spend is a second proportion, and
            drawing it as a second bar would put two tracks in one header and
            re-create at the lane level exactly the double statement #3148
            removed at the slot level. The dashed hairline separates the two
            facts without adding a channel that competes with the bar (D4). */}
        {showCost && phaseBudgetAtCompletion != null && (
          <div
            className="flex items-center gap-1 flex-wrap text-xs border-t border-dashed border-neutral-border pt-2"
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
