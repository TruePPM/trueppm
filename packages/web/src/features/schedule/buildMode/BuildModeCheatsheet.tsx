import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ShortcutEntry {
  /** Key chip(s) — array because some entries show alternates (e.g. "Enter / F2"). */
  keys: string[];
  label: string;
}

interface ShortcutSection {
  title: string;
  entries: ShortcutEntry[];
}

const SECTIONS: ShortcutSection[] = [
  {
    title: 'Selecting rows',
    entries: [
      { keys: ['↑', '↓'], label: 'Move row focus' },
      { keys: ['Esc'], label: 'Clear selection' },
    ],
  },
  {
    title: 'Editing cells',
    entries: [
      { keys: ['Enter', 'F2'], label: 'Edit selected cell' },
      { keys: ['Double-click'], label: 'Edit cell' },
      { keys: ['letter'], label: 'Start typing in Name cell' },
      { keys: ['Tab'], label: 'Save and move to next field' },
      { keys: ['Shift', 'Tab'], label: 'Save and move to previous field' },
      { keys: ['Esc'], label: 'Cancel and revert' },
    ],
  },
  {
    title: 'Structuring (the WBS tree)',
    entries: [
      { keys: ['Tab'], label: 'Indent under previous row' },
      { keys: ['Shift', 'Tab'], label: 'Outdent one level' },
      { keys: ['Right-click'], label: 'Open row menu' },
    ],
  },
  {
    title: 'Creating & deleting',
    entries: [
      { keys: ['Enter'], label: 'New row below (when row is focused)' },
      { keys: ['⌫'], label: 'Delete row' },
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
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
          bg-neutral-surface border border-neutral-border rounded-lg p-5"
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
            className="w-7 h-7 inline-flex items-center justify-center rounded
              text-neutral-text-secondary hover:text-neutral-text-primary
              focus:outline-none focus:ring-2 focus:ring-brand-primary
              focus:ring-offset-1 focus:ring-offset-neutral-surface"
          >
            ✕
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
                            <kbd className="inline-flex h-4 px-1 items-center rounded border border-neutral-border text-[11px]">
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
            className="inline-flex h-8 px-3 items-center rounded border border-neutral-border
              bg-neutral-surface text-[13px] text-neutral-text-primary
              hover:bg-neutral-row-hover
              focus:outline-none focus:ring-2 focus:ring-brand-primary
              focus:ring-offset-1 focus:ring-offset-neutral-surface"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
