/**
 * What the outline drag promises before you let go (#2954).
 *
 * A bare insertion line is not enough here, and that is the whole design point.
 * The same pointer y can mean "put it beside this row" or "put it inside this
 * row, which then becomes a phase", and a line alone cannot tell those apart —
 * so the indicator carries a **consequence**, in words, on the row it will
 * happen to. A drag that only draws a line asks the user to guess, and a guess
 * that turns out wrong costs a reparent and an undo.
 *
 * Three marks, each doing one job:
 *
 *  - the **line**, whose left inset is the *destination's* depth-guide x — a
 *    child drop draws exactly one `WBS_INDENT` deeper than a sibling drop, so
 *    the two are told apart by position and not by color alone (rule 6.1);
 *  - the **target band**, a wash on the row the drop acts on;
 *  - the **chip**, the sentence's short form: `↳ becomes a phase`,
 *    `into this phase`, `same level as X`, or a refusal.
 *
 * Every mark is `aria-hidden` and `pointer-events-none`. The claim is spoken
 * through the schedule's polite live region by `useOutlineDrag` — this is the
 * sighted channel for it, not its only carrier — and a layer over the list that
 * forgets `pointer-events-none` reintroduces the #2782 class where a decorative
 * overlay froze the task list (web rule 309(b)).
 */

import { dropIndicatorGeometry, describeDropIntent, type DropIntent } from './outlineDrag';
import type { OutlineDragRow } from './outlineDrag';

export interface OutlineDropIndicatorProps {
  intent: DropIntent;
  rows: OutlineDragRow[];
  draggedId: string;
  rowHeight: number;
  /**
   * Horizontal lane the rows reserve for the ⋮⋮ grip (#2997) — zero on a fine
   * pointer, 44 on a coarse one. The insertion line's whole job is to name a
   * *level* by its x, so it has to start from the same origin the rows' depth
   * guides do; without this the line points one indent step shallow on touch.
   */
  leftInset?: number;
}

export function OutlineDropIndicator({
  intent,
  rows,
  draggedId,
  rowHeight,
  leftInset = 0,
}: OutlineDropIndicatorProps) {
  const geometry = dropIndicatorGeometry(intent, rows, rowHeight);
  const description = describeDropIntent(intent, rows, draggedId);
  if (!geometry || !description) return null;

  const refused = description.tone === 'refused';
  // A refusal is never a "you may drop here" line — it marks the row that said
  // no, and says why. Drawing an insertion line for it would be an offer.
  const lineTop = refused ? null : geometry.lineTop;

  return (
    <div
      aria-hidden="true"
      data-testid="outline-drop-indicator"
      data-drop-kind={intent.kind}
      data-drop-tone={description.tone}
      className="pointer-events-none absolute inset-x-0 top-0 bottom-0 z-20"
    >
      {geometry.targetTop != null && (
        <div
          data-testid="outline-drop-target-band"
          className={
            // `bg-semantic-critical-bg`, never `bg-semantic-critical/N`: the two
            // are different hues, not different alphas (rule 8b).
            refused
              ? 'absolute inset-x-0 bg-semantic-critical-bg ring-1 ring-inset ring-semantic-critical'
              : 'absolute inset-x-0 bg-brand-primary/10 ring-1 ring-inset ring-brand-primary'
          }
          style={{ top: geometry.targetTop, height: rowHeight }}
        />
      )}

      {lineTop != null && (
        <div
          data-testid="outline-drop-line"
          data-indent={geometry.indent}
          className="absolute right-0 h-0.5 -translate-y-1/2 rounded-full bg-brand-primary"
          style={{ top: lineTop, left: leftInset + geometry.indent }}
        >
          {/* The knob anchors the line to its indent origin, so "which level" is
              readable at a glance rather than inferred from where the line stops. */}
          <span className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-brand-primary" />
        </div>
      )}

      {geometry.targetTop != null && (
        <span
          data-testid="outline-drop-consequence"
          className={[
            'absolute right-2 top-0 flex items-center rounded border px-1.5 text-xs font-medium',
            'whitespace-nowrap',
            refused
              ? 'border-semantic-critical bg-semantic-critical text-neutral-text-inverse'
              : 'border-brand-primary bg-brand-primary text-neutral-text-inverse',
          ].join(' ')}
          style={{ top: geometry.targetTop + 2, height: rowHeight - 4 }}
        >
          {description.chip}
        </span>
      )}
    </div>
  );
}
