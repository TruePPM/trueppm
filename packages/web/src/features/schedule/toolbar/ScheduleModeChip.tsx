/**
 * The Schedule toolbar's mode control — one control, every width (#3263).
 *
 * It shipped in #3076 as the *collapsed* form of a two-pill cluster: below the
 * width where `Build mode` and the `Read / Author` pill both fit, they became
 * one chip. #3263 removed the wide form. Two controls answering "what can I do
 * to this plan right now" did not fit conceptually at any width either — a user
 * asking whether they are allowed to edit got two answers in two places, and
 * nothing on screen said how they composed. The narrow-width reading was the
 * team having already found the collision; this is that reading applied
 * everywhere.
 *
 * **Build mode is not one of the two answers.** `buildModeActive` is
 * `!isMobile` — a constant wherever this renders — so the old "Author · Build"
 * / "Read · Build off" value had a half that could never say anything else.
 * The spec promotes build mode out of the flag: it is a property of authoring
 * on a pointer-and-keyboard machine, not a mode a person chooses. So the chip
 * states the one mode that varies, and the retired `BuildModePill`'s actual
 * job — being the always-on way in to the keyboard cheatsheet — is carried by
 * the `Keyboard shortcuts…` item below.
 *
 * The cluster has no `overflow` state and never demotes into `···`: a mode you
 * must open a menu to *read* is a mode you forget you are in, and the cost of
 * that is typing into a plan you believe is read-only (rule 343(e)). The
 * trigger therefore always shows its value, and the accessible name carries the
 * whole value and the consequence, not just "Mode" (rule 287).
 */
import { ToolbarOverflowMenu } from '@/components/toolbar/ToolbarOverflowMenu';
import { formatChord } from '@/lib/platform';
import type { ScheduleAuthorMode } from '@/hooks/useScheduleAuthorMode';

export interface ScheduleModeChipProps {
  mode: ScheduleAuthorMode;
  onToggleMode: () => void;
  onShowCheatsheet: () => void;
}

export function ScheduleModeChip({
  mode,
  onToggleMode,
  onShowCheatsheet,
}: ScheduleModeChipProps) {
  const isRead = mode === 'read';
  const modeWord = isRead ? 'Read' : 'Author';
  // Derived, never spelled — the same rule 326(b)/339(b) reason as the menu row
  // below. A hard-coded "Alt+A" here would have a Mac user HEAR "Alt+A" from the
  // trigger and READ "⌥A" from the row two lines down, for one binding.
  const chord = formatChord('alt+a');

  return (
    <ToolbarOverflowMenu
      triggerTestId="schedule-mode-chip"
      // The chord belongs on the trigger too, not only on the row inside the
      // popover: rule 343(f) requires a control keep its name AND its
      // `aria-keyshortcuts`, and a chord you must open a menu to discover is not
      // discoverable from the control.
      triggerAriaKeyShortcuts="Alt+A"
      // States the consequence, not just the state: "Read" alone does not tell
      // a screen-reader user that their edits are blocked, and the chord is the
      // one-keystroke way out that the pointer path costs two interactions.
      triggerAriaLabel={
        isRead
          ? `Mode: Read — edits are blocked. ${chord} switches to Author.`
          : `Mode: Author — edits are allowed. ${chord} switches to Read.`
      }
      // No leading glyph. The word *is* the signal (rule 6 — colour is never
      // the sole carrier), and there is no house icon for "read" —
      // `EyeOffIcon` means hidden, and an emoji is a rule-242 violation, so a
      // chip that needed one would have to mint a glyph to say what the label
      // already says.
      triggerLabel={<span className="whitespace-nowrap">{modeWord}</span>}
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
          // and `aria-checked` is what carries the current answer.
          kind: 'checkbox',
          id: 'author-mode',
          label: 'Author mode',
          checked: !isRead,
          onChange: onToggleMode,
          // The only checkbox in this menu, so "stay open to toggle several"
          // buys nothing and costs a third interaction — and an open popover
          // covers the trigger whose value just changed.
          closeOnChange: true,
          shortcut: chord,
          ariaKeyShortcuts: 'Alt+A',
        },
        {
          // The retired `BuildModePill`'s job. #3115 removed the toolbar
          // Milestone button on the strength of a replacement; this entry is
          // the replacement for the pill, and it ships in the same change that
          // removes it rather than being owed.
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
