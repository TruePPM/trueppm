import type { PasteSummary } from './buildPasteOperations';
import { formatChord } from '@/lib/platform';
import { shouldDiscloseUndoFloor } from '@/lib/roles';

const FIELD_LABEL: Record<string, string> = {
  name: 'name',
  duration: 'duration',
  owner: 'owner',
  units: 'allocation',
};

/** Builds the receipt copy — "38 rows pasted. Hierarchy read from leading
 *  indentation — 4 levels. name · duration · owner matched · 2 columns ignored
 *  · 3 rows need a duration." Each clause only appears when it has something
 *  to say, so a clean flat paste reads as a short, confident sentence.
 *
 *  The two owner clauses are separate sentences, not clauses in the `·` run
 *  (#2905). The run reports what the paste *did*; an owner the roster could not
 *  resolve is work the author asked for and did not get, and it needs to say what
 *  to do about it — a typo needs correcting, an ambiguous name needs a fuller one.
 *  Folding either into the `·` list would put a call to action in a list of
 *  statistics, where it reads as one more count to skim past. */
export function buildPasteReceiptMessage(summary: PasteSummary): string {
  const noun = `row${summary.rowCount !== 1 ? 's' : ''}`;
  const sentences = [`${summary.rowCount} ${noun} pasted.`];
  if (summary.levelCount > 1) {
    sentences.push(`Hierarchy read from leading indentation — ${summary.levelCount} levels.`);
  }

  const clauses: string[] = [];
  if (summary.matchedFields.length > 0) {
    clauses.push(`${summary.matchedFields.map((f) => FIELD_LABEL[f] ?? f).join(' · ')} matched`);
  }
  if (summary.ignoredColumnCount > 0) {
    clauses.push(
      `${summary.ignoredColumnCount} column${summary.ignoredColumnCount !== 1 ? 's' : ''} ignored`,
    );
  }
  if (summary.needsDurationCount > 0) {
    const isPlural = summary.needsDurationCount !== 1;
    clauses.push(
      `${summary.needsDurationCount} row${isPlural ? 's' : ''} need${isPlural ? '' : 's'} a duration`,
    );
  }
  if (clauses.length > 0) sentences.push(`${clauses.join(' · ')}.`);

  const owners = (n: number) => `${n} owner${n === 1 ? '' : 's'}`;
  const wasWere = (n: number) => (n === 1 ? 'was' : 'were');

  if (summary.unmatchedOwnerCount > 0) {
    const n = summary.unmatchedOwnerCount;
    sentences.push(
      `${owners(n)} ${wasWere(n)} not on the roster, so ${wasWere(n)} not applied — ` +
        `check the spelling, or add them to the team.`,
    );
  }
  if (summary.ambiguousOwnerCount > 0) {
    const n = summary.ambiguousOwnerCount;
    sentences.push(
      `${owners(n)} matched more than one person, so ${wasWere(n)} not applied — ` +
        `use a fuller name.`,
    );
  }
  return sentences.join(' ');
}

/** What the strip says instead of offering an Undo the caller cannot use (#3353).
 *
 *  Shaped after `ClassificationPopover`'s note, per rule 379's copy clause: it names
 *  what happens to THIS reader, and puts the role in the RECOVERY clause phrased as
 *  rights. Naming the floor as the requirement ("needs the Project Manager role")
 *  would be wrong copy for an Owner, who holds the right under a different label,
 *  and for an Enterprise band role, which holds it under an arbitrary one.
 *
 *  Exported for its unit test and so the copy has one home: the same sentence has
 *  to read correctly whether the author reaches for the button or the chord.
 */
export const UNDO_NEEDS_ADMIN_NOTE =
  'You cannot reverse this paste in one step — someone with Project Manager rights ' +
  'can. The rows are ordinary tasks, so you can delete them yourself.';

interface PasteReceiptStripProps {
  summary: PasteSummary;
  isUndoing: boolean;
  /**
   * The server's `can_undo` for this batch (#3353, web rule 373), tri-state per
   * rule 379: the two outputs it drives have OPPOSITE safe defaults, so it is not
   * normalized to a boolean before it gets here.
   *
   * - The Undo control is an **affordance** → raised only on `=== true`, so an
   *   unresolved verdict withholds it rather than offering one the server refuses.
   *   Omitted, never disabled (rule 302, ux-review §6.1).
   * - The note is a **disclosure** → shown only on an affirmative `=== false`
   *   (`shouldDiscloseUndoFloor`), so an unresolved verdict stays silent rather
   *   than telling a Project Manager they lack a right they hold.
   */
  canUndo: boolean | undefined;
  onUndo: () => void;
  onKeep: () => void;
  onMapColumns: () => void;
}

/**
 * Undo-able receipt after a paste-many batch commits (#2724). Stays on screen
 * until the author acts — Keep, Undo (⌘Z), or "Map columns…" — rather than
 * auto-dismissing like a delete toast: the needs-a-duration count it reports
 * stays walkable with F8 for as long as the strip is up.
 *
 * That persistence is why this strip *does* carry the disclosure rule 373(d)
 * withheld from the classification toast. The objection there was structural — an
 * 8-second `aria-live` region cannot carry a second clause, and the hover-or-focus
 * reveal a tooltip needs is a race the reader loses. Neither applies here: the
 * strip stays until the author acts, and the note is in its live region's own text.
 */
export function PasteReceiptStrip({
  summary,
  isUndoing,
  canUndo,
  onUndo,
  onKeep,
  onMapColumns,
}: PasteReceiptStripProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="paste-receipt-strip"
      className="flex items-center gap-3 w-full px-3 py-2 rounded border border-neutral-border
        bg-neutral-surface-raised text-xs text-neutral-text-primary"
    >
      <span className="flex-1 min-w-0">
        {buildPasteReceiptMessage(summary)}
        {shouldDiscloseUndoFloor(canUndo) && (
          <span className="text-neutral-text-secondary"> {UNDO_NEEDS_ADMIN_NOTE}</span>
        )}
      </span>
      <button
        type="button"
        onClick={onMapColumns}
        className="flex-shrink-0 h-7 px-2 rounded text-xs font-medium text-neutral-text-secondary
          hover:text-neutral-text-primary
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        Map columns…
      </button>
      {canUndo === true && (
        <button
          type="button"
          onClick={onUndo}
          disabled={isUndoing}
          // The label's "⌘" is U+2318 PLACE OF INTEREST SIGN, which screen readers
          // announce inconsistently. `aria-keyshortcuts` is the reliable handle and
          // names the Ctrl form the handler also accepts — same treatment as the CSV
          // wizard's Undo. Additive: it does not change the accessible name.
          aria-keyshortcuts="Meta+Z Control+Z"
          className="flex-shrink-0 h-7 px-3 rounded text-xs font-semibold text-brand-primary
            underline underline-offset-2 hover:no-underline disabled:opacity-50
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          {isUndoing ? 'Undoing…' : `Undo (${formatChord('mod+z')})`}
        </button>
      )}
      <button
        type="button"
        onClick={onKeep}
        disabled={isUndoing}
        className="flex-shrink-0 h-7 px-3 rounded text-xs font-medium
          border border-neutral-border text-neutral-text-secondary hover:text-neutral-text-primary
          disabled:opacity-50
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        Keep
      </button>
    </div>
  );
}
