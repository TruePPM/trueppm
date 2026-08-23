/**
 * Sentences for structural acts on the outline (#2948, epic #2946).
 *
 * Every structural gesture — indent, outdent, move, delete, convert, insert —
 * says what it did. The same sentence goes to the screen reader through the
 * schedule's polite live region and into the session trail, so the tree never
 * changes silently and the change is still there to inspect afterwards.
 *
 * Two rules the copy follows, both from the design handoff:
 *
 *  - **State the consequence, not the mechanism.** "moves under the one above,
 *    and that row becomes a phase" — not "parent_id updated". The mechanism is
 *    not what the user needs to decide whether to undo it.
 *  - **Name what it cost.** A delete that took a subtree says how many rows went
 *    with it. That number is the whole reason the sentence exists.
 *
 * Pure on purpose: the wording is the part worth testing, and it can be tested
 * without a renderer or a server.
 */

/** A row, reduced to what a sentence needs to say about it. */
export interface ActRow {
  name: string;
  /** Structural descendants that travel with it. */
  descendantCount?: number;
}

/**
 * A row with no name yet is a real state — `insertBelow` creates one before the
 * user types. "Untitled indented under Mobilization" reads better than a gap,
 * and matches how the outline itself renders it.
 */
function label(row: ActRow): string {
  const trimmed = (row.name ?? '').trim();
  return trimmed.length > 0 ? trimmed : 'Untitled';
}

export function indentSentence(row: ActRow, parent: ActRow, parentBecamePhase: boolean): string {
  const tail = parentBecamePhase ? ', which is now a phase' : '';
  return `${label(row)} indented under ${label(parent)}${tail}.`;
}

export function outdentSentence(row: ActRow, formerParent: ActRow): string {
  return `${label(row)} outdented out of ${label(formerParent)}.`;
}

export function moveSentence(row: ActRow, direction: 'up' | 'down'): string {
  const carried =
    row.descendantCount && row.descendantCount > 0
      ? ` with ${row.descendantCount} ${row.descendantCount === 1 ? 'item' : 'items'} under it`
      : '';
  return `${label(row)} moved ${direction}${carried}. Reordering does not change any dates.`;
}

/**
 * A pointer drag or "Move to…" that changed where a row lives (#2954).
 *
 * Distinct from {@link moveSentence}, which covers `⌥↑`/`⌥↓` — reordering among
 * siblings never changes containment, and saying "moved down" about a row that
 * just changed parents would describe the wrong half of what happened. The
 * destination is named; "moved" without a destination is the sentence a user
 * cannot check against the tree.
 *
 * `destination` is null for the WBS root, which has no row to name.
 */
export function movedIntoSentence(
  row: ActRow,
  destination: ActRow | null,
  destinationBecamePhase = false,
): string {
  const n = row.descendantCount ?? 0;
  const carried = n > 0 ? ` with ${n} ${n === 1 ? 'item' : 'items'} under it` : '';
  const where = destination ? `into ${label(destination)}` : 'to the top level';
  const tail = destination && destinationBecamePhase ? ', which is now a phase' : '';
  return `${label(row)} moved ${where}${carried}${tail}. Moving does not change any dates.`;
}

export function deleteSentence(row: ActRow): string {
  const n = row.descendantCount ?? 0;
  const carried = n > 0 ? ` with ${n} ${n === 1 ? 'item' : 'items'} under it` : '';
  return `${label(row)} deleted${carried}.`;
}

/** Where a newly created row landed, from the gesture that created it. */
export type InsertPlacement = 'below' | 'above' | 'child' | 'end';

/**
 * A new row (#3018) — the most frequent structural act, and the one that was
 * silent for three releases because this function existed and nothing imported it.
 *
 * Every form names **where the row landed**, which is the only thing a user cannot
 * see for themselves: the caret moves into a Name cell that reads "New task" no
 * matter which of the four gestures made it, so "added" alone would be a sentence
 * that cannot be checked against the tree. `end` has no anchor — the foot of the
 * plan is not inside anything — so it names the level instead, the same way
 * {@link movedIntoSentence} names the top level when there is no destination row.
 */
export function insertSentence(where: InsertPlacement, anchor: ActRow | null): string {
  if (where === 'end' || anchor === null) {
    return 'New item added at the end of the plan, at the top level.';
  }
  if (where === 'child') return `New item added under ${label(anchor)}.`;
  return `New item added ${where} ${label(anchor)}, at the same level.`;
}

/**
 * `⇧⏎` created the row but the reorder that would have placed it failed (#3018).
 *
 * "Added above X" is composed of two requests — the create endpoint appends at the
 * end of the parent's children, and only the reorder lifts the row into place. When
 * the second half fails the row is real and in the wrong place, so the earlier
 * sentence has become false. Correcting it out loud is the whole point: an
 * announcement a user cannot trust is worse than one that never came, and the trail
 * is a log, so the correction lands beside the claim rather than erasing it.
 */
export function insertMisplacedSentence(anchor: ActRow): string {
  return `Added the row, but couldn’t place it above ${label(anchor)} — it is at the end of that level instead.`;
}

export function milestoneSentence(row: ActRow, becameMilestone: boolean): string {
  return becameMilestone
    ? `${label(row)} is a milestone — zero duration, so it marks a date rather than taking time.`
    : `${label(row)} is a task again.`;
}

/**
 * Group / Ungroup (#2955) — the trail's record of a wrap and its reversal.
 *
 * These two deliberately do NOT live with the rest of the group copy in
 * `buildMode/groupOutcome.ts`. That module writes the *outcome notice*, which explains
 * the consequence at the moment it happens and can afford three sentences; the trail is
 * a scannable list of ten acts, where three sentences per row would bury the one the
 * user is looking for. Same act, two lengths, and the shorter one still names what it
 * cost — `leftAloneCount` is the number a user would otherwise have to count by eye.
 */
export function groupSentence(groupedCount: number, leftAloneCount = 0): string {
  const n = groupedCount;
  const head = `${n} ${n === 1 ? 'item is' : 'items are'} now a phase.`;
  if (leftAloneCount <= 0) return head;
  const k = leftAloneCount;
  return `${head} ${k} ${k === 1 ? 'row' : 'rows'} stayed where ${k === 1 ? 'it was' : 'they were'}.`;
}

export function ungroupSentence(container: ActRow, liftedCount: number): string {
  const n = liftedCount;
  const moved =
    n === 0
      ? 'It was empty, so nothing moved.'
      : `Its ${n} ${n === 1 ? 'item' : 'items'} moved up one level, keeping links, owners and estimates.`;
  return `${label(container)} is no longer a phase. ${moved}`;
}

export function duplicateSentence(row: ActRow): string {
  const n = row.descendantCount ?? 0;
  const carried = n > 0 ? ` with ${n} ${n === 1 ? 'item' : 'items'} under it` : '';
  return `${label(row)} duplicated${carried}. Dependencies are not copied.`;
}
