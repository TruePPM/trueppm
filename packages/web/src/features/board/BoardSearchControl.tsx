/**
 * BoardSearchControl — collapsible board card search box (issue 323, ADR-0145).
 *
 * Collapsed to a magnifier at rest; expands to an input on focus or when it
 * carries a query. A result-count chip and a clear (×) button appear while a
 * query is present. Pressing `/` anywhere on the board focuses it (BoardView
 * owns the key handler and the ref); Escape clears + collapses.
 */
import { type RefObject, useState } from 'react';

export interface BoardSearchControlProps {
  value: string;
  onChange: (q: string) => void;
  /** Server match count for the active query (shown in the count chip). */
  matchCount: number;
  /** True while a non-empty query is in flight (count chip shows "…"). */
  isSearching: boolean;
  /** Owned by BoardView so the `/` shortcut can focus the field. */
  inputRef: RefObject<HTMLInputElement | null>;
}

export function BoardSearchControl({
  value,
  onChange,
  matchCount,
  isSearching,
  inputRef,
}: BoardSearchControlProps) {
  const [focused, setFocused] = useState(false);
  const hasQuery = value.trim().length > 0;
  const expanded = focused || hasQuery;

  return (
    <div role="search" className="flex items-center gap-1">
      <div className="relative flex items-center">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-2 text-xs text-neutral-text-secondary"
        >
          ⌕
        </span>
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onChange('');
              e.currentTarget.blur();
            }
          }}
          placeholder="Search cards…"
          aria-label="Search cards"
          aria-keyshortcuts="/"
          // `search` inputs render a native clear affordance in some browsers; the
          // explicit × button below is the cross-browser control. Width animates
          // between the collapsed magnifier (w-7) and the expanded field (w-44).
          className={[
            'rounded-full border border-neutral-border bg-neutral-surface',
            'pl-6 pr-2 py-1 text-xs text-neutral-text-primary',
            'focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
            'focus-visible:outline-none transition-[width] duration-150',
            'placeholder:text-neutral-text-disabled',
            '[&::-webkit-search-cancel-button]:appearance-none',
            expanded ? 'w-44' : 'w-7 cursor-pointer',
          ].join(' ')}
        />
      </div>
      {hasQuery && (
        <>
          <span
            role="status"
            aria-live="polite"
            className="rounded-full bg-neutral-surface-raised px-1.5 py-0.5 text-[11px] tabular-nums text-neutral-text-secondary"
          >
            {isSearching ? '…' : `${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`}
          </span>
          <button
            type="button"
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="inline-flex h-5 w-5 items-center justify-center rounded-full text-neutral-text-secondary hover:bg-neutral-surface-raised focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}
