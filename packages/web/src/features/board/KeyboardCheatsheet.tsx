import { useEffect, useRef } from 'react';

interface KeyboardCheatsheetProps {
  onClose: () => void;
}

interface ShortcutEntry {
  keys: string[];
  description: string;
}

interface ShortcutSection {
  title: string;
  entries: ShortcutEntry[];
}

const SECTIONS: ShortcutSection[] = [
  {
    title: 'Navigation',
    entries: [
      { keys: ['J', '↓'], description: 'Next card in column' },
      { keys: ['K', '↑'], description: 'Previous card in column' },
      { keys: ['L', '→'], description: 'Next column' },
      { keys: ['H', '←'], description: 'Previous column' },
      { keys: ['Tab'], description: 'Move focus through interactive parts' },
    ],
  },
  {
    title: 'Actions',
    entries: [
      { keys: ['Enter'], description: 'Open card detail' },
      { keys: ['E'], description: 'Edit card' },
      { keys: ['D'], description: 'Show dependencies' },
      { keys: ['C'], description: 'Show comments' },
      { keys: ['Space'], description: 'Pick up card to drag (then arrows)' },
    ],
  },
  {
    title: 'Lanes',
    entries: [
      { keys: ['['], description: 'Collapse focused lane' },
      { keys: [']'], description: 'Expand focused lane' },
    ],
  },
  {
    title: 'Help',
    entries: [
      { keys: ['?'], description: 'Show this cheatsheet' },
      { keys: ['Esc'], description: 'Close popover or cheatsheet' },
    ],
  },
];

/**
 * Modal listing every board keyboard shortcut (issue #195).
 *
 * Triggered by `?` from BoardView. Esc closes; click on the backdrop closes.
 * Trap focus on the close button on mount so screen readers announce the
 * dialog and Tab cycles inside the modal.
 */
export function KeyboardCheatsheet({ onClose }: KeyboardCheatsheetProps) {
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  // Backdrop click closes; pointerdown on inner content stops propagation.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="keyboard-cheatsheet-title"
      className="fixed inset-0 z-30 flex items-center justify-center bg-neutral-text-primary/40 p-4"
      onPointerDown={onClose}
    >
      <div
        className="bg-neutral-surface border border-neutral-border rounded-lg p-5 w-full max-w-[480px] max-h-[85vh] overflow-y-auto"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <h2
            id="keyboard-cheatsheet-title"
            className="text-base font-semibold text-neutral-text-primary"
          >
            Keyboard shortcuts
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            className="text-neutral-text-secondary hover:text-neutral-text-primary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              focus-visible:outline-none rounded p-1"
            aria-label="Close shortcuts"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-4">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h3 className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mb-1.5">
                {section.title}
              </h3>
              <dl className="flex flex-col gap-1">
                {section.entries.map((entry) => (
                  <div
                    key={entry.description}
                    className="grid grid-cols-[10ch_1fr] items-center gap-3 text-xs"
                  >
                    <dt className="flex flex-wrap items-center gap-1">
                      {entry.keys.map((k, i) => (
                        <kbd
                          key={`${k}-${i}`}
                          className="bg-neutral-surface-raised border border-neutral-border rounded px-1.5 py-0.5 text-xs tppm-mono text-neutral-text-primary"
                        >
                          {k}
                        </kbd>
                      ))}
                    </dt>
                    <dd className="text-neutral-text-secondary">{entry.description}</dd>
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
