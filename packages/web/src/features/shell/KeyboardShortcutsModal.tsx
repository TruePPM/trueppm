import { useFocusTrap } from '@/hooks/useFocusTrap';
import { modifierKeyLabel } from '@/lib/platform';

interface Props {
  onClose: () => void;
}

interface Shortcut {
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  heading: string;
  shortcuts: Shortcut[];
}

/**
 * The app's real, wired keyboard bindings — each entry maps to a live handler:
 * the command palette hotkey (useCommandPaletteHotkey), the sidebar toggle
 * (useSidebarCollapseHotkey), the command-palette navigation (CommandPalette),
 * and the board roving-focus keys (useBoardKeyboard). Nothing here is aspirational;
 * grep the handlers before adding a row (issue 1556).
 */
function useShortcutGroups(): ShortcutGroup[] {
  const mod = modifierKeyLabel();
  return [
    {
      heading: 'Global',
      shortcuts: [
        { keys: [`${mod}K`], label: 'Open the command palette' },
        { keys: [`${mod}B`], label: 'Show or hide the sidebar' },
        { keys: ['Esc'], label: 'Close an open dialog or menu' },
      ],
    },
    {
      heading: 'Command palette',
      shortcuts: [
        { keys: ['↑', '↓'], label: 'Move between results' },
        { keys: ['↵'], label: 'Run the selected action' },
        { keys: ['Esc'], label: 'Close the palette' },
      ],
    },
    {
      heading: 'Board',
      shortcuts: [
        { keys: ['J', 'K'], label: 'Move focus between cards' },
        { keys: ['H', 'L'], label: 'Move focus between columns' },
      ],
    },
    {
      // Schedule (Gantt) keyboard reschedule — the pointer-free equivalent of
      // dragging a bar (useKeyboardReschedule, #1742). All keys are wired; the
      // in-canvas instruction strip (rule 51) shows the same bindings live.
      heading: 'Schedule (Gantt)',
      shortcuts: [
        { keys: ['↵'], label: 'Reschedule the selected task' },
        { keys: ['←', '→'], label: 'Nudge by one working day' },
        { keys: ['⇧', '←', '→'], label: 'Nudge by five working days' },
        { keys: ['D'], label: 'Enter an exact date' },
        { keys: ['Esc'], label: 'Cancel the reschedule' },
      ],
    },
  ];
}

export function KeyboardShortcutsModal({ onClose }: Props) {
  // Modal cheatsheet: contain Tab/Shift+Tab inside the dialog, focus the close
  // button on open, and close on Escape (WCAG 2.4.3 / 2.1.2).
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);
  const groups = useShortcutGroups();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      <div
        className="fixed inset-0 bg-neutral-overlay"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={trapRef}
        tabIndex={-1}
        className="relative z-10 bg-neutral-surface border border-neutral-border rounded-card p-6 w-80 flex flex-col gap-4 focus:outline-none"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-text-primary">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="text-neutral-text-secondary hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded-control"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M12.207 4.207a1 1 0 0 0-1.414-1.414L8 5.586 5.207 2.793a1 1 0 0 0-1.414 1.414L6.586 8l-2.793 2.793a1 1 0 1 0 1.414 1.414L8 10.414l2.793 2.793a1 1 0 0 0 1.414-1.414L9.414 8l2.793-2.793z" />
            </svg>
          </button>
        </div>
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <section key={group.heading} className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
                {group.heading}
              </h3>
              <dl className="flex flex-col gap-1.5">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.label}
                    className="flex items-center justify-between gap-4"
                  >
                    <dt className="text-sm text-neutral-text-primary">{shortcut.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((key) => (
                        <kbd
                          key={key}
                          className="tppm-mono rounded-chip border border-neutral-border px-1.5 py-0.5 text-xs text-neutral-text-secondary"
                        >
                          {key}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
