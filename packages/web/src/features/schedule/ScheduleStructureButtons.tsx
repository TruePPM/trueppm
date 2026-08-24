import { useId } from 'react';
import {
  describeGroupTarget,
  describeUngroupTarget,
  type GroupTarget,
  type UngroupTarget,
} from './buildMode/groupOutcome';

const BUTTON_CLASS = [
  // Matches the "+ Item" peer exactly (h-7 px-3, neutral border, brand hover) — these
  // are creation-adjacent controls in the same row and a third visual weight would read
  // as a third kind of thing.
  'inline-flex h-7 px-3 items-center gap-1.5 rounded-control text-xs font-medium',
  'border border-neutral-border text-neutral-text-primary transition-colors shrink-0 whitespace-nowrap',
  'hover:border-brand-primary hover:text-brand-primary',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
  'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-disabled disabled:border-neutral-border disabled:cursor-not-allowed disabled:hover:border-neutral-border disabled:hover:text-neutral-text-disabled',
].join(' ');

export interface ScheduleStructureButtonsProps {
  group: GroupTarget;
  ungroup: UngroupTarget;
  onGroup: () => void;
  onUngroup: () => void;
  /** True while either restructure is in flight — prevents a double-fire. */
  pending: boolean;
  /** An editor who chose Read. A user with no rights gets no buttons at all. */
  readOnly: boolean;
}

/**
 * Group / Ungroup in the toolbar (#2955, epic #2946).
 *
 * **Why these two are in the toolbar at all.** Every other structural gesture has a
 * row-level home — indent and outdent are on the row menu, move is a drag, delete is on
 * the row. These two are not *about* a row: Group acts on a selection and Ungroup acts
 * on a container's whole contents, and neither has a sensible per-row equivalent. That
 * is the test the design applies, and it is why they are the only additions here.
 *
 * **Off by default, and that is a ruling, not an oversight.** `⌥⌘G` and `⇥` already make
 * phases, and the #2959 persona panel split on whether the buttons earn their toolbar
 * width; the leaner reading won, so `displayOptions.structureButtons` gates the whole
 * group and starts false. The Display menu's Outline section is the route back, and it
 * is also the pointer-only user's route *in* — the chord is a complete keyboard path,
 * and turning the buttons on once is a complete pointer path.
 *
 * **The description states the count before the act, not after** (web rule 316). A user
 * who is told afterwards that two of their six rows were left alone has already lost the
 * chance to fix the selection. What it never does is predict *which* rows: the drop rule
 * is the server's verdict and a client-side mirror of it would be a confident wrong
 * answer (rule 301). It names the rule, and the outcome notice names the result.
 */
export function ScheduleStructureButtons({
  group,
  ungroup,
  onGroup,
  onUngroup,
  pending,
  readOnly,
}: ScheduleStructureButtonsProps) {
  const groupHintId = useId();
  const ungroupHintId = useId();
  const groupHint = describeGroupTarget(group);
  const ungroupHint = describeUngroupTarget(ungroup);
  const groupDisabled = readOnly || pending || group.blocked !== null;
  const ungroupDisabled = readOnly || pending || ungroup.blocked !== null;

  return (
    <>
      <button
        type="button"
        onClick={onGroup}
        disabled={groupDisabled}
        data-testid="group-rows-button"
        // The accessible name stays stable as the selection moves (rule 316): a button
        // that renames itself on every arrow key is disorienting, so the count that
        // changes lives in the description, which is announced on focus.
        aria-label="Group selected rows into a phase (Option+Cmd+G)"
        aria-describedby={groupHint ? groupHintId : undefined}
        title={readOnly ? 'Read-only access' : (groupHint ?? 'Select rows to group')}
        className={BUTTON_CLASS}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          {/* A bracket closing around two rows — the shape of the act. */}
          <path d="M3.5 2 H2 V12 H3.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.5 2 H12 V12 H10.5" stroke="currentColor" strokeWidth="1.4" />
          <rect x="4.75" y="4" width="4.5" height="1.6" rx="0.8" fill="currentColor" />
          <rect x="4.75" y="8.4" width="4.5" height="1.6" rx="0.8" fill="currentColor" />
        </svg>
        Group
      </button>
      <button
        type="button"
        onClick={onUngroup}
        disabled={ungroupDisabled}
        data-testid="ungroup-rows-button"
        aria-label="Ungroup this phase (Option+Shift+Cmd+G)"
        aria-describedby={ungroupHint ? ungroupHintId : undefined}
        title={readOnly ? 'Read-only access' : (ungroupHint ?? 'Focus a phase to ungroup it')}
        className={BUTTON_CLASS}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          {/* The same bracket, opened outward. */}
          <path d="M2.5 2 H1 V12 H2.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M11.5 2 H13 V12 H11.5" stroke="currentColor" strokeWidth="1.4" />
          <rect x="4" y="6.2" width="6" height="1.6" rx="0.8" fill="currentColor" />
        </svg>
        Ungroup
      </button>
      {/*
        `sr-only` rather than rendered text (rule 316(c)): the toolbar is already a
        flex-nowrap row that has to survive a narrow viewport, and a visible sentence
        here would be the first thing squeezed to zero width while still passing
        `toHaveText`. `display:none` would take it out of the accessibility tree too, so
        the sentence is always readable to assistive tech and never drawn.
      */}
      <span id={groupHintId} className="sr-only">
        {groupHint ?? ''}
      </span>
      <span id={ungroupHintId} className="sr-only">
        {ungroupHint ?? ''}
      </span>
    </>
  );
}
