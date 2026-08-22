import { describeInsertTarget, type InsertTarget } from './buildMode/insertTarget';

export interface ScheduleInsertTargetStatementProps {
  target: InsertTarget;
  /**
   * Whether this reader may author at all. Without rights the statement is
   * ABSENT, not dimmed — web rule 302. It describes a mutation, and narrating a
   * mutation nothing offers is noise, not help.
   */
  hasEditRights: boolean;
}

/**
 * The toolbar's "here is where my insert lands" sentence (#2957).
 *
 * Two deliberate omissions:
 *
 * - **No `aria-live`.** The sentence changes on every arrow-key row move, so a
 *   live region would speak over the row announcement a planner is actually
 *   navigating by — the same reasoning that keeps `BuildModeHintStrip` silent
 *   (web rule 194). It stays in the reading order; it just is not auto-spoken.
 * - **No fallback sentence.** When nothing is focused there is no row to land
 *   after, so the component renders nothing rather than inventing a claim. A
 *   sentence that describes a *different* affordance's behavior (the footer's
 *   append-at-the-end) is exactly the collapse #2957 exists to undo.
 */
export function ScheduleInsertTargetStatement({
  target,
  hasEditRights,
}: ScheduleInsertTargetStatementProps) {
  if (!hasEditRights) return null;
  const statement = describeInsertTarget(target);
  if (!statement) return null;
  return (
    <span
      data-testid="schedule-insert-target"
      data-target-kind={target.kind}
      // `min-w-` matters as much as `max-w-`: the toolbar is `flex-nowrap` and
      // crowded, so a shrinkable span with `truncate` collapses to zero width
      // and the sentence is "rendered" while being invisible. Dropped below xl,
      // where the create cluster has no room to spare.
      className="hidden xl:inline-flex items-center min-w-[9rem] max-w-[20rem] truncate
        whitespace-nowrap text-xs text-neutral-text-secondary"
    >
      {statement}
    </span>
  );
}
