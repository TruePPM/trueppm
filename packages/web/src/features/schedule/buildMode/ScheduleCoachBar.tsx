import { CloseIcon } from '@/components/Icons';

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
  { key: '⌥→', label: 'indent', before: 'Indent an item — ', bold: 'the one above becomes a phase' },
  { key: '⌥⌘G', label: 'group', before: 'Select rows, ', bold: 'wrap them in a phase', after: ' — name it last' },
  { key: 'hover a row', label: 'row controls', before: '', bold: '+ ⇤ ⇥ ◆', after: ' — insert, move, milestone' },
];

interface Props {
  onDismiss: () => void;
  onShowCheatsheet: () => void;
}

/**
 * A three-line coach above the outline (#2959, epic #2946).
 *
 * Discovery was hover-dependent, and the `?` cheatsheet was the only teacher —
 * so a user who never hovered a row never learned that the row controls existed
 * at all.
 *
 * Dismissible, and **restorable from Display options**. That pairing is the
 * whole point: the strip this replaces could only ever be dismissed, which left
 * a keyboard user who hid it with no route back to the one surface that
 * explained the keyboard.
 */
export function ScheduleCoachBar({ onDismiss, onShowCheatsheet }: Props) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-1.5 border-b border-neutral-border
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
