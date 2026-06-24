/**
 * The Fibonacci card row for estimation poker (ADR-0179, issue 863) — a single-select
 * radiogroup with roving tabindex (rule 167) and arrow-key navigation. The trailing "?"
 * card is the unsure vote (value `null`).
 */

import { useRef } from 'react';

const CARDS: readonly (number | null)[] = [1, 2, 3, 5, 8, 13, 21, null];

function label(card: number | null): string {
  return card === null ? '?' : String(card);
}

function ariaLabel(card: number | null): string {
  return card === null ? 'Unsure' : `${card} points`;
}

export function FibonacciCardRow({
  value,
  onSelect,
  disabled = false,
  groupLabel = 'Your estimate',
}: {
  /** The selected card; `undefined` = nothing selected yet. `null` = the "?" card. */
  value: number | null | undefined;
  onSelect: (card: number | null) => void;
  disabled?: boolean;
  groupLabel?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // The roving-tabindex anchor: the selected card, or the first card when none is selected.
  const selectedIndex = CARDS.findIndex((c) => c === value);
  const anchor = selectedIndex === -1 ? 0 : selectedIndex;

  function move(delta: number, from: number) {
    const next = (from + delta + CARDS.length) % CARDS.length;
    refs.current[next]?.focus();
    onSelect(CARDS[next]);
  }

  return (
    <div role="radiogroup" aria-label={groupLabel} className="flex flex-wrap gap-1.5">
      {CARDS.map((card, i) => {
        const selected = card === value;
        return (
          <button
            key={label(card)}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={ariaLabel(card)}
            disabled={disabled}
            tabIndex={i === anchor ? 0 : -1}
            onClick={() => onSelect(card)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(1, i);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(-1, i);
              }
            }}
            className={`min-w-11 h-12 rounded border tppm-mono text-base font-medium
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              disabled:opacity-50 disabled:cursor-not-allowed ${
                selected
                  ? 'bg-brand-primary text-white border-brand-primary'
                  : 'border-neutral-border text-neutral-text-primary hover:bg-neutral-surface'
              }`}
          >
            {label(card)}
          </button>
        );
      })}
    </div>
  );
}
