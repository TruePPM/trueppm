import { useEffect, useRef, useState } from 'react';
import { CloseIcon, SearchIcon } from '@/components/Icons';

interface Props {
  /** Committed (debounced) query value. */
  value: string;
  onChange: (next: string) => void;
  resultCount: number;
  totalCount: number;
  debounceMs?: number;
}

/**
 * Inline name/code filter for the /programs directory (issue #1796). Keeps a
 * local value so typing feels instant and debounces the upward commit; the
 * "n of m" counter is `aria-live="polite"` so screen-reader users hear the
 * result count settle without it firing on every keystroke. Esc clears + blurs.
 *
 * Mirrors the backlog SearchInput pattern but stands alone (no `?q=` URL
 * canonicalization — the /programs filter is transient page state).
 */
export function ProgramSearchInput({
  value,
  onChange,
  resultCount,
  totalCount,
  debounceMs = 150,
}: Props) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Re-sync when the value is reset from outside (e.g. "Clear filters").
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
    <div className="relative flex h-9 min-w-[220px] flex-1 items-center rounded-control border border-neutral-border bg-neutral-surface-sunken sm:max-w-[300px]">
      <SearchIcon
        aria-hidden="true"
        className="ml-2.5 h-3.5 w-3.5 shrink-0 text-neutral-text-secondary"
      />
      <input
        type="search"
        aria-label="Filter programs by name"
        placeholder="Filter programs…"
        value={local}
        onChange={(e) => emit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && hasQuery) {
            e.preventDefault();
            clear();
            e.currentTarget.blur();
          }
        }}
        className="h-full min-w-0 flex-1 rounded-control bg-transparent px-2 text-sm text-neutral-text-primary
          placeholder:text-neutral-text-secondary focus:outline-none focus-visible:ring-2
          focus-visible:ring-brand-primary focus-visible:ring-offset-1
          [&::-webkit-search-cancel-button]:hidden"
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
            aria-label="Clear filter"
            className="mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-neutral-text-secondary
              hover:bg-neutral-surface hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            <CloseIcon aria-hidden="true" className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  );
}
