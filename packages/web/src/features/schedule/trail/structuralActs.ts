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

export function deleteSentence(row: ActRow): string {
  const n = row.descendantCount ?? 0;
  const carried = n > 0 ? ` with ${n} ${n === 1 ? 'item' : 'items'} under it` : '';
  return `${label(row)} deleted${carried}.`;
}

export function insertSentence(where: 'below' | 'above' | 'child', anchor: ActRow): string {
  if (where === 'child') return `New item added under ${label(anchor)}.`;
  return `New item added ${where} ${label(anchor)}, at the same level.`;
}

export function milestoneSentence(row: ActRow, becameMilestone: boolean): string {
  return becameMilestone
    ? `${label(row)} is a milestone — zero duration, so it marks a date rather than taking time.`
    : `${label(row)} is a task again.`;
}

export function duplicateSentence(row: ActRow): string {
  const n = row.descendantCount ?? 0;
  const carried = n > 0 ? ` with ${n} ${n === 1 ? 'item' : 'items'} under it` : '';
  return `${label(row)} duplicated${carried}. Dependencies are not copied.`;
}
