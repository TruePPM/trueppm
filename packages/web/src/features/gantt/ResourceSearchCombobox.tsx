import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useResourceSearch } from '@/hooks/useResourceSearch';

export interface ResourceSearchComboboxProps {
  onSelect: (resourceId: string, resourceName: string) => void;
  onDismiss: () => void;
}

export function ResourceSearchCombobox({ onSelect, onDismiss }: ResourceSearchComboboxProps) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);

  // Debounce 200ms
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(id);
  }, [query]);

  // Preload first 20 on mount (empty query)
  const { data: results = [] } = useResourceSearch(debouncedQuery);
  const visibleResults = results.slice(0, 20);

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reset active index when results change
  useEffect(() => {
    setActiveIndex(-1);
  }, [debouncedQuery]);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, visibleResults.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < visibleResults.length) {
          const r = visibleResults[activeIndex];
          onSelect(r.id, r.name);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onDismiss();
        break;
    }
  }

  const activeOptionId =
    activeIndex >= 0 && activeIndex < visibleResults.length
      ? `${listboxId}-option-${activeIndex}`
      : undefined;

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={visibleResults.length > 0}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        aria-label="Search resources"
        placeholder="Search resources…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full text-xs border border-neutral-border rounded px-2 py-1
          bg-neutral-surface text-neutral-text-primary placeholder:text-neutral-text-disabled
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      />

      {visibleResults.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Resource options"
          className="absolute left-0 right-0 top-full mt-1 z-50
            max-h-40 overflow-y-auto
            border border-neutral-border rounded
            bg-neutral-surface-raised"
        >
          {visibleResults.map((r, i) => (
            <li
              key={r.id}
              id={`${listboxId}-option-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              // onPointerDown prevents the input blur before selection fires
              onPointerDown={(e) => {
                e.preventDefault();
                onSelect(r.id, r.name);
              }}
              className={[
                'px-2 py-1.5 text-xs cursor-pointer',
                'text-neutral-text-primary',
                i === activeIndex
                  ? 'bg-brand-primary/10 text-brand-primary'
                  : 'hover:bg-neutral-surface',
              ].join(' ')}
            >
              {r.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
