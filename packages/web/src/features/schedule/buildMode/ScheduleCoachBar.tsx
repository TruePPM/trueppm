import { CloseIcon } from '@/components/Icons';
import { formatChord } from '@/lib/platform';

interface CoachLine {
  key: string;
  label: string;
  /** Rendered after the key chip. Kept as parts so the bold lands on the consequence. */
  before: string;
  bold: string;
  after?: string;
}

/**
 * The three lines are ordered by what a static screen cannot otherwise teach.
 * The middle one drops first when space runs short — the hover line has to
 * survive, because hover affordances are exactly the thing you cannot discover
 * by looking.
 */
/**
 * `⌥→`, not `⇥` (#3020). Tab is bound to nothing and deliberately so: binding it
 * reproduces the WCAG 2.1.2 keyboard trap fixed in #2192/#2727 (ADR-0776 §6, and
 * `TaskListRow`'s `tryBuildModeIndent` doc comment). A chip naming a dead key is
 * worse here than on any other surface — this bar's entire justification is that
 * discovery was hover-dependent, so a user who tries the key it teaches and gets
 * nothing concludes the *feature* is broken rather than the hint.
 *
 * Note the third line's `+ ⇤ ⇥ ◆` is a different claim and is correct: those are
 * the row's own **button glyphs**, which is the design's chosen notation, not a
 * keystroke. `scheduleTeachingChords.test.tsx` encodes exactly that distinction
 * — a `<kbd>` chip is a keystroke claim and must resolve against the registered
 * bindings; prose naming glyphs is not.
 */
const LINES: readonly CoachLine[] = [
  { key: formatChord('alt+ArrowRight'), label: 'indent', before: 'Indent an item — ', bold: 'the one above becomes a phase' },
  { key: formatChord('mod+alt+g'), label: 'group', before: 'Select rows, ', bold: 'wrap them in a phase', after: ' — name it last' },
  { key: 'hover a row', label: 'row controls', before: '', bold: '+ ⇤ ⇥ ◆', after: ' — insert, move, milestone' },
];

interface Props {
  onDismiss: () => void;
  onShowCheatsheet: () => void;
}

/**
 * A three-line coach in the band below the outline (#2959, epic #2946).
 *
 * Discovery was hover-dependent, and the `?` cheatsheet was the only teacher —
 * so a user who never hovered a row never learned that the row controls existed
 * at all.
 *
 * Dismissible, and **restorable from Display options**. That pairing is the
 * whole point: the strip this replaces could only ever be dismissed, which left
 * a keyboard user who hid it with no route back to the one surface that
 * explained the keyboard.
 *
 * ## When it renders (web rule 363, #3134)
 *
 * Only while the outline is idle (`NoSelection`) and the canvas is drawing at
 * least one row. `BuildModeHintStrip` is anchored to focus state and selection
 * size, which is strictly narrower than this bar's anchor (build mode is on),
 * so the two are partitioned rather than stacked — see `teachingSurfaces.ts`.
 *
 * "Stacked" is literal, and it is why the border below is `border-t` and not
 * `border-b`. Measured at 1920×1080 with two rows, this bar drew at `y=978`
 * (29px) and the hint strip at `y=979` (28px): the same band, in the same slot
 * under the outline, and before the partition they queued one above the other
 * for ~57px of hint bars. So this is one band with two contents, not two bands
 * — which means it has to draw the same frame in both states. `border-b` gave
 * it a rule on the wrong edge, leaving no separation from the outline above and
 * doubling against `ScheduleForecastBar`'s own `border-t` below.
 *
 * All three lines stay. The row-controls line in particular is the ONLY line
 * here with no counterpart in the strip, so the tempting "drop the duplicated
 * item" edit would delete this bar's stated reason to exist and keep the two
 * lines that genuinely are duplicated. The overlap is the indent chord (line 1)
 * and the group chord (line 2), both of which the strip re-teaches from its own
 * narrower anchor at the moment each becomes performable.
 *
 * Standing down is not being dismissed. The caller suppresses the render and
 * never touches `displayOptions.coach`, so clearing a selection brings the bar
 * back for a planner who never hid it, and the Display-menu checkbox keeps
 * meaning what it says.
 */
export function ScheduleCoachBar({ onDismiss, onShowCheatsheet }: Props) {
  return (
    <div
      // `role="group"`, because a bare <div> maps to `role="generic"`, which is
      // name-PROHIBITED — the `aria-label` below was being discarded outright
      // and a screen-reader user met the two buttons with no container context.
      // Exactly the fact `ScheduleInsertTargetStatement` cites as its reason for
      // using real text rather than an attribute; it was true here too.
      role="group"
      className="flex items-center gap-3 px-4 py-1.5 border-t border-neutral-border
        bg-neutral-surface-sunken text-xs text-neutral-text-secondary flex-shrink-0 overflow-hidden"
      aria-label="How the outline works"
    >
      <button
        type="button"
        onClick={onShowCheatsheet}
        className="inline-flex items-center gap-1.5 shrink-0 font-medium text-neutral-text-primary
          hover:text-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-1 rounded-control"
      >
        How this works
        <kbd className="inline-flex h-4 px-1 items-center rounded-chip border border-neutral-border bg-neutral-surface tppm-mono">
          ?
        </kbd>
      </button>

      {LINES.map((line, i) => (
        <span
          key={line.key}
          className={[
            'items-center gap-1.5 min-w-0 truncate',
            // The middle line is the first to go: `hidden lg:flex` on it, while
            // the hover line survives to `md`.
            i === 1 ? 'hidden lg:flex' : 'hidden md:flex',
          ].join(' ')}
        >
          <kbd className="inline-flex h-4 px-1 items-center rounded-chip border border-neutral-border bg-neutral-surface tppm-mono shrink-0">
            {line.key}
          </kbd>
          <span className="truncate">
            {line.before}
            <b className="font-medium text-neutral-text-primary">{line.bold}</b>
            {line.after}
          </span>
        </span>
      ))}

      <span className="flex-1" />
      <button
        type="button"
        onClick={onDismiss}
        // Says where it went, because a control that vanishes with no route back
        // is the defect this bar is replacing.
        aria-label="Hide the how-to bar — bring it back from Display options"
        title="Hide — bring it back from Display options"
        className="shrink-0 text-neutral-text-secondary hover:text-neutral-text-primary
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded-control"
      >
        <CloseIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
