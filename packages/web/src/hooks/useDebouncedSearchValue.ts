import { useEffect, useRef, useState } from 'react';

interface UseDebouncedSearchValueResult {
  /** The input's own value — updates immediately on every keystroke. */
  local: string;
  hasQuery: boolean;
  /** Update the local value immediately and debounce the upward commit. */
  emit: (next: string) => void;
  /** Clear immediately, with no debounce (Esc / the clear button). */
  clear: () => void;
}

/**
 * Local-first debounced search/filter input state, shared by the backlog,
 * grooming, and programs-directory search fields (#3903). The caller owns the
 * canonical `value` (URL param, filter state, …); this hook keeps a local
 * value so typing feels instant, debounces the upward `onChange` commit, and
 * re-syncs `local` when `value` changes from outside the input itself (e.g. a
 * "Clear filters" action elsewhere on the page).
 */
export function useDebouncedSearchValue(
  value: string,
  onChange: (next: string) => void,
  debounceMs: number,
): UseDebouncedSearchValueResult {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

  return { local, hasQuery: local.trim().length > 0, emit, clear };
}
