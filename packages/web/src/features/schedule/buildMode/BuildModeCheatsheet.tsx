import { useEffect, useRef } from 'react';
import { modifierKeyLabel, altKeyLabel } from '@/lib/platform';
import { createPortal } from 'react-dom';
import { CloseIcon } from '@/components/Icons';

interface ShortcutEntry {
  /** Key chip(s) — array because some entries show alternates (e.g. "Enter / F2"). */
  keys: string[];
  label: string;
}

interface ShortcutSection {
  title: string;
  entries: ShortcutEntry[];
}

// The duration example is composed rather than written as a literal: next to a quote
// it is indistinguishable from a short hex color to check-design-system-v2.sh, whose
// ratchet shares the # character with the token grammar.
const DURATION_EXAMPLE = `${'#'}5d`;

// Resolved once at module load: the labels are platform facts, not state, and
// the cheatsheet is remounted per open. `⌘`/`⌥` printed to a Linux reader names
// keys their keyboard does not have (#3028).
const MOD = modifierKeyLabel();
const ALT = altKeyLabel();
const SHIFT = 'Shift';

const SECTIONS: ShortcutSection[] = [
  {
    title: 'Selecting rows',
    entries: [
      { keys: ['↑', '↓'], label: 'Move row focus' },
      { keys: ['Shift', '↑', '↓'], label: 'Extend selection' },
      { keys: [MOD, 'A'], label: 'Select siblings, then the whole tree' },
      { keys: ['Shift', 'Click'], label: 'Extend the selection to the row you click' },
      { keys: ['F8'], label: 'Jump to next unresolved @owner or missing duration' },
      { keys: ['Shift', 'F8'], label: 'Jump to previous unresolved @owner or missing duration' },
      { keys: ['F7'], label: 'Jump to next row that needs dates' },
      { keys: ['Shift', 'F7'], label: 'Jump to previous row that needs dates' },
      // A read, not an edit — it is in this section rather than under the
      // authoring actions because it is the one row action every role has (#2979).
      { keys: [ALT, '⏎'], label: 'Open the focused row’s details' },
      { keys: ['Esc'], label: 'Clear selection' },
    ],
  },
  {
    title: 'Editing cells',
    entries: [
      { keys: ['F2'], label: 'Edit selected cell' },
      { keys: ['Double-click'], label: 'Edit cell' },
      { keys: ['letter'], label: 'Start typing in Name cell' },
      { keys: ['Tab'], label: 'Save and move to next field' },
      { keys: ['Shift', 'Tab'], label: 'Save and move to previous field' },
      { keys: ['⌫'], label: 'On an empty Name cell: merge into the row above' },
      { keys: ['Esc'], label: 'Cancel and revert (discards an untouched new row)' },
    ],
  },
  {
    title: 'Creating rows',
    entries: [
      { keys: ['⏎'], label: 'New row below, same level' },
      { keys: ['Shift', '⏎'], label: 'New row above, same level' },
      { keys: [MOD, '⏎'], label: 'New child row (one level deeper)' },
      {
        keys: [MOD, 'V'],
        label: 'Paste spreadsheet rows — hierarchy read from leading indentation',
      },
      { keys: [MOD, 'Z'], label: 'Undo the last paste, while its receipt is showing' },
      // Scoped deliberately (#2974): ⌘Z reverses the six structural gestures the
      // server records, and duplicate / convert-to-milestone are NOT among them.
      // Advertising a bare "Undo" here would promise a reversal this tree cannot
      // perform, which is the exact defect the issue was filed for.
      {
        keys: [MOD, 'Z'],
        label: 'Undo the last move, indent, outdent, reorder or grouping',
      },
    ],
  },
  {
    title: 'Structuring (the WBS tree)',
    entries: [
      { keys: [ALT, '→'], label: 'Indent under previous row' },
      { keys: [ALT, '←'], label: 'Outdent one level' },
      { keys: [ALT, '↑'], label: 'Move row (and its subtree) up' },
      { keys: [ALT, '↓'], label: 'Move row (and its subtree) down' },
      // The three structure acts (#2955). Listed here rather than under "Creating
      // rows" because all three change what CONTAINS what, which is what this
      // section is: ⇥ and ⌥→ make a phase from the top down, these make one around
      // work that already exists.
      { keys: [ALT, MOD, 'G'], label: 'Group the selected rows into a phase — name it last' },
      {
        keys: [ALT, SHIFT, MOD, 'G'],
        label: 'Ungroup this phase — its rows come up one level, keeping links and owners',
      },
      { keys: [ALT, MOD, 'P'], label: 'New phase, with its first task already in it' },
      { keys: ['Right-click'], label: 'Open row menu' },
    ],
  },
  {
    title: 'Quick actions',
    entries: [
      { keys: ['Space'], label: 'Mark complete / un-complete focused row' },
      { keys: [MOD, 'D'], label: 'Duplicate row and its subtree' },
      { keys: ['⌫'], label: 'Delete row (no selection: focused row; with a selection: every selected row)' },
      { keys: [ALT, 'A'], label: 'Toggle Author / Read mode' },
      {
        keys: [MOD, SHIFT, 'M'],
        label: 'Classify this subtree — governance and delivery mode, with a preview',
      },
      {
        keys: [MOD, SHIFT, 'K'],
        label: 'Edit every selected row — owner, classification, dates',
      },
    ],
  },
  {
    // Every token also has a toolbar button and a `/` command-menu entry, so the
    // syntax is a shortcut for people who want one — never the only way in (#2722).
    title: 'Inline tokens (type in the Name cell)',
    entries: [
      { keys: ['/'], label: 'Command menu — every token and action, by name' },
      { keys: [DURATION_EXAMPLE], label: 'Duration — 5 days. #2w for weeks, bare number for days' },
      { keys: ['@ana'], label: 'Owner — @ana:50 allocates 50%' },
      { keys: ['>2.3'], label: 'Predecessor by WBS or name — >2.3+2d lag, >2.3-1d lead' },
      { keys: ['!'], label: 'Milestone — same as #0' },
      { keys: ['~sprint'], label: 'Delivery mode on this row — also ~gated, ~kanban' },
      { keys: ['[Design]'], label: 'Move under a phase by name' },
    ],
  },
  {
    title: 'Token pickers',
    entries: [
      { keys: ['↑', '↓'], label: 'Choose a suggestion' },
      { keys: ['Tab'], label: 'Accept the highlighted suggestion' },
      { keys: ['Esc'], label: 'Dismiss the picker, leaving your text untouched' },
      { keys: [ALT, '→'], label: 'Cycle dependency type FS → SS → FF → SF' },
    ],
  },
  {
    title: 'Dependencies',
    entries: [
      { keys: ['Hover'], label: 'Reveal predecessor (blue) and successor (green) chain' },
      { keys: ['Right-click'], label: 'Add predecessor / successor via picker' },
    ],
  },
  {
    title: 'Help',
    entries: [{ keys: ['?'], label: 'Show / hide this list' }],
  },
];

export interface BuildModeCheatsheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Centered modal listing every build-mode keyboard shortcut, grouped by phase
 * of work. Opens via the `?` key or the toolbar pill / hint strip CTA.
 * Closes on Escape, on click outside the panel, on the Close button, and on
 * pressing `?` again. Focus is trapped inside the modal while open.
 */
export function BuildModeCheatsheet({ open, onClose }: BuildModeCheatsheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Focus the close button on open so Esc + Enter both work immediately,
  // and trap Tab so focus does not escape the modal.
  useEffect(() => {
    if (!open) return;
    closeBtnRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cheatsheet-title"
        className="w-[480px] max-w-[90vw] max-h-[85vh] overflow-y-auto
          bg-neutral-surface border border-neutral-border rounded-card p-5"
      >
        <div className="flex items-center justify-between mb-3">
          <h2 id="cheatsheet-title" className="text-[15px] font-semibold text-neutral-text-primary">
            Schedule shortcuts
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
            className="w-7 h-7 inline-flex items-center justify-center rounded-control
              text-neutral-text-secondary hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface"
          >
            <CloseIcon className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <dl className="space-y-4">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <dt className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-2">
                {section.title}
              </dt>
              <dd>
                <ul className="space-y-1.5">
                  {section.entries.map((entry) => (
                    <li
                      key={`${section.title}-${entry.keys.join('+')}-${entry.label}`}
                      className="flex items-baseline gap-3"
                    >
                      <span className="w-24 text-right shrink-0 text-[12px] tppm-mono text-neutral-text-secondary">
                        {entry.keys.map((k, i) => (
                          <span key={`${k}-${i}`}>
                            {i > 0 && <span className="opacity-50"> + </span>}
                            <kbd className="inline-flex h-4 px-1 items-center rounded-chip border border-neutral-border text-xs">
                              {k}
                            </kbd>
                          </span>
                        ))}
                      </span>
                      <span className="text-[13px] text-neutral-text-primary">
                        {entry.label}
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            </section>
          ))}
        </dl>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 px-3 items-center rounded-control border border-neutral-border
              bg-neutral-surface text-[13px] text-neutral-text-primary
              hover:bg-neutral-row-hover
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
