/**
 * The Schedule toolbar's collapsed mode cluster (#3076).
 *
 * Below the width where `Build mode` and the `Read / Author` pill both fit,
 * they become one chip. The chip is **not** an overflow trigger and the cluster
 * is never demoted into `···`: a mode is the thing you must be able to read
 * before you start typing, and a mode indicator hidden inside a menu is a mode
 * you forget you are in. So the trigger keeps showing its *value* —
 * "Author · Build", "Read · Build off" — and only the two controls that change
 * it move into the popover.
 *
 * The accessible name carries the whole value for the same reason (rule 287,
 * and the design's "collapsed clusters announce the whole value"): a chip that
 * announced only "Mode" would be worse than the two buttons it replaced.
 */
import { ToolbarOverflowMenu } from '@/components/toolbar/ToolbarOverflowMenu';
import { formatChord } from '@/lib/platform';
import type { ScheduleAuthorMode } from '@/hooks/useScheduleAuthorMode';

export interface ScheduleModeChipProps {
  mode: ScheduleAuthorMode;
  onToggleMode: () => void;
  /** Whether keyboard build mode is live — the second half of the chip's value. */
  buildModeActive: boolean;
  onShowCheatsheet: () => void;
}

export function ScheduleModeChip({
  mode,
  onToggleMode,
  buildModeActive,
  onShowCheatsheet,
}: ScheduleModeChipProps) {
  const isRead = mode === 'read';
  const modeWord = isRead ? 'Read' : 'Author';
  const buildWord = buildModeActive ? 'Build' : 'Build off';
  const value = `${modeWord} · ${buildWord}`;

  return (
    <ToolbarOverflowMenu
      triggerAriaLabel={`Mode: ${modeWord}, keyboard build mode ${buildModeActive ? 'on' : 'off'}`}
      // No leading glyph. The two words *are* the signal (rule 6 — colour is
      // never the sole carrier), and there is no house icon for "read" —
      // `EyeOffIcon` means hidden, and an emoji is a rule-242 violation, so a
      // chip that needed one would have to mint a glyph to say what the label
      // already says.
      triggerLabel={<span className="whitespace-nowrap">{value}</span>}
      triggerClassName={[
        'inline-flex shrink-0 items-center gap-1.5 h-7 px-2 rounded-control border',
        'text-xs font-medium whitespace-nowrap',
        // `focus:`, not `focus-visible:` — rule 4's standalone-trigger carve-out
        // outranks the Schedule tree's rule-137 default here: this is a popover
        // trigger, and Firefox/desktop Safari withhold `:focus-visible` on a
        // pointer-initiated focus, leaving a clicked chip with no ring at all.
        'focus:outline-none focus:ring-2 focus:ring-brand-primary',
        'focus:ring-offset-1 focus:ring-offset-neutral-surface',
        isRead
          ? 'border-neutral-border bg-neutral-surface-raised text-neutral-text-secondary hover:bg-neutral-row-hover'
          : 'border-brand-primary/30 bg-brand-primary/8 text-brand-primary hover:bg-brand-primary/12',
      ].join(' ')}
      items={[
        {
          // A checkbox, not two actions: "am I allowed to type" is one boolean,
          // and `aria-checked` is what carries the current answer. This is the
          // same state the expanded `AuthorModePill` publishes as `aria-label` —
          // one value, correct role for whichever container it is in.
          kind: 'checkbox',
          id: 'author-mode',
          label: 'Author mode',
          checked: !isRead,
          onChange: onToggleMode,
          // Derived, never spelled: a literal chord tells every Windows and
          // Linux user the Mac binding on the one surface they cannot correct
          // it against (rule 326(b)/339(b)).
          shortcut: formatChord('alt+a'),
          ariaKeyShortcuts: 'Alt+A',
        },
        {
          kind: 'action',
          id: 'cheatsheet',
          label: 'Keyboard shortcuts…',
          onSelect: onShowCheatsheet,
          shortcut: '?',
          ariaKeyShortcuts: '?',
        },
      ]}
    />
  );
}
