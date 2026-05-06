import type { KeyboardEvent } from 'react';
import type { GridMode } from './persistence';

const MODE_ORDER: readonly GridMode[] = ['flat', 'outline', 'grouped'] as const;
const MODE_LABEL: Record<GridMode, string> = {
  flat: 'Flat list',
  outline: 'Outline tree',
  grouped: 'Grouped',
};
const MODE_SHORT: Record<GridMode, string> = {
  flat: 'Flat',
  outline: 'Outline',
  grouped: 'Grouped',
};

interface ModeToggleProps {
  mode: GridMode;
  onChange: (next: GridMode) => void;
}

/**
 * Segmented control for switching between Flat / Outline / Grouped modes.
 * Per ADR-0053 § 2 and the UX spec, this uses `role="group"` (not `role="tablist"`)
 * because the modes re-shape the same data — they aren't independent tab panels.
 */
export function ModeToggle({ mode, onChange }: ModeToggleProps) {
  const handleKeyDown = (e: KeyboardEvent, current: GridMode) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const idx = MODE_ORDER.indexOf(current);
    const next =
      e.key === 'ArrowRight'
        ? MODE_ORDER[(idx + 1) % MODE_ORDER.length]
        : MODE_ORDER[(idx - 1 + MODE_ORDER.length) % MODE_ORDER.length];
    if (next) onChange(next);
  };

  return (
    <div
      role="group"
      aria-label="Display mode"
      className="inline-flex h-7 rounded border border-neutral-border overflow-hidden"
    >
      {MODE_ORDER.map((m, i) => {
        const isActive = m === mode;
        return (
          <button
            key={m}
            type="button"
            aria-pressed={isActive}
            aria-label={MODE_LABEL[m]}
            onClick={() => onChange(m)}
            onKeyDown={(e) => handleKeyDown(e, m)}
            className={[
              'px-3 text-xs font-medium transition-colors min-w-[64px]',
              i > 0 ? 'border-l border-neutral-border' : '',
              isActive
                ? 'bg-brand-primary text-white'
                : 'bg-transparent text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-sunken',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:relative focus-visible:z-10',
            ].join(' ')}
          >
            {MODE_SHORT[m]}
          </button>
        );
      })}
    </div>
  );
}
