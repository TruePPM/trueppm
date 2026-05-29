/**
 * Backlog search field. The URL (`?q=`) is canonical, but typing must feel
 * instant, so the input keeps a local value and debounces the upward `?q=`
 * write by 200ms (the design recommendation). `/` focuses it from anywhere on
 * the page (wired by the toolbar); Esc clears + blurs.
 *
 * The "3 of 9" counter is `aria-live="polite"` so screen-reader users hear the
 * result count settle without it firing on every keystroke.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { CloseIcon, SearchIcon } from '@/components/Icons';
import { FOCUS_RING } from './styles';

interface SearchInputProps {
  value: string;
  onChange: (next: string) => void;
  resultCount: number;
  totalCount: number;
  inputRef?: RefObject<HTMLInputElement | null>;
  debounceMs?: number;
  /** Stretch to the container width (mobile) instead of the 260px desktop min. */
  fullWidth?: boolean;
}

export function SearchInput({
  value,
  onChange,
  resultCount,
  totalCount,
  inputRef,
  debounceMs = 200,
  fullWidth = false,
}: SearchInputProps) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Re-sync when the URL value changes from outside (e.g. Clear search / reset).
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
      className={`relative flex items-center rounded-md border border-neutral-border bg-neutral-surface-sunken ${
        fullWidth ? 'h-[34px] w-full rounded-lg' : 'h-[30px] min-w-[260px]'
      }`}
    >
      <SearchIcon
        aria-hidden="true"
        className="ml-2.5 h-3 w-3 shrink-0 text-neutral-text-secondary"
      />
      <input
        ref={inputRef}
        type="search"
        aria-label="Search backlog"
        placeholder="Search backlog…"
        value={local}
        onChange={(e) => emit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && hasQuery) {
            e.preventDefault();
            clear();
            e.currentTarget.blur();
          }
        }}
        className={`h-full flex-1 bg-transparent px-2 text-sm text-neutral-text-primary
          placeholder:text-neutral-text-secondary focus:outline-none ${FOCUS_RING} rounded-md
          [&::-webkit-search-cancel-button]:hidden`}
      />
      {hasQuery && (
        <>
          <span
            aria-live="polite"
            className="tppm-mono mr-1 shrink-0 text-xs tabular-nums text-neutral-text-secondary"
          >
            {resultCount} of {totalCount}
          </span>
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className={`mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-text-secondary
              hover:bg-neutral-surface hover:text-neutral-text-primary ${FOCUS_RING}`}
          >
            <CloseIcon aria-hidden="true" className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  );
}
