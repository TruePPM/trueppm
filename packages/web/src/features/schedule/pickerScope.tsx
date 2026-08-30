import { useEffect, useState } from 'react';

/**
 * Debounce a rapidly-changing value (a search box) before it reaches a query
 * hook, so keystrokes do not each fan out into a request. 200ms is the interval
 * both task pickers shipped with; keep them in step by changing it here.
 */
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/**
 * A single tab in a picker's scope segmented control. `tabIndex -1` keeps focus
 * on the search input; the toggle is driven by click or the ←/→ window bindings.
 */
export function ScopeTab({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={-1}
      onClick={onSelect}
      className={[
        'h-7 rounded-control px-2 font-medium transition-colors',
        selected
          ? 'bg-brand-primary text-neutral-text-inverse'
          : 'text-neutral-text-secondary hover:text-neutral-text-primary',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
