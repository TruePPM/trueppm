/**
 * Debounced title search for the grooming filter bar (issue 1044).
 *
 * The parent owns the canonical query, but typing must feel instant, so the
 * input keeps a local value and debounces the upward write by 200ms — the same
 * pattern as the program backlog's SearchInput, kept project-local (that one is
 * program-feature-scoped and styled to the program toolbar). Esc clears + blurs.
 * The "N of M" counter is aria-live=polite so it settles without firing on every
 * keystroke. No global "/" shortcut is wired — it would collide with page-level
 * bindings, and the grooming bar is always in view.
 */

import { useEffect, useRef, useState } from 'react';
import { CloseIcon, SearchIcon } from '@/components/Icons';

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';

interface GroomingSearchInputProps {
  value: string;
  onChange: (next: string) => void;
  /** Result count shown as "N of M" when a query is present. */
  resultCount: number;
  totalCount: number;
  debounceMs?: number;
  /** Stretch to the container width (mobile) instead of the desktop min-width. */
  fullWidth?: boolean;
}

export function GroomingSearchInput({
  value,
  onChange,
  resultCount,
  totalCount,
  debounceMs = 200,
  fullWidth = false,
}: GroomingSearchInputProps) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Re-sync when the query is cleared/reset from outside (Clear filters).
  useEffect(() => {
    setLocal(value);
  }, [value]);

  useEffect(() => () => clearTimeout(timer.current), []);

  function emit(next: string) {
    setLocal(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(next), debounceMs);
  }

  function clear() {
    clearTimeout(timer.current);
    setLocal('');
    onChange('');
  }

  const hasQuery = local.trim().length > 0;

  return (
    <div
      className={`relative flex items-center rounded-control border border-neutral-border bg-neutral-surface-sunken ${
        fullWidth ? 'h-[34px] w-full' : 'h-[30px] min-w-[220px]'
      }`}
    >
      <SearchIcon aria-hidden="true" className="ml-2.5 h-3 w-3 shrink-0 text-neutral-text-secondary" />
      <input
        type="search"
        aria-label="Search stories"
        placeholder="Search stories…"
        value={local}
        onChange={(e) => emit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && hasQuery) {
            e.preventDefault();
            clear();
            e.currentTarget.blur();
          }
        }}
        className={`h-full flex-1 bg-transparent px-2 text-sm text-neutral-text-primary placeholder:text-neutral-text-secondary focus:outline-none ${FOCUS_RING} rounded-control [&::-webkit-search-cancel-button]:hidden`}
      />
      {hasQuery && (
        <>
          <span
            aria-live="polite"
            className="mr-1 shrink-0 font-mono text-xs tabular-nums text-neutral-text-secondary"
          >
            {resultCount} of {totalCount}
          </span>
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className={`mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface hover:text-neutral-text-primary ${FOCUS_RING}`}
          >
            <CloseIcon aria-hidden="true" className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  );
}
