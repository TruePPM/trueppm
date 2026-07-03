/**
 * Shared skill-catalog search combobox.
 *
 * Debounced autocomplete over GET /api/v1/skills/?search= (via useSkillCatalog),
 * with the same ARIA listbox + keyboard-navigation contract as
 * AddToRosterCombobox. Extracted as a shared primitive (issue 1612) so both the
 * org-level resource detail panel and any future roster skill editor pick skills
 * through one component instead of re-implementing the picker.
 *
 * The combobox clears its own query after each selection so callers can add
 * several skills in a row without remounting it.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Skill } from '@/types';
import { useSkillCatalog } from '@/hooks/useSkillCatalog';

export interface SkillComboboxProps {
  /** Called with the chosen skill; the combobox then clears its query. */
  onSelect: (skill: Skill) => void;
  /** Called on Escape so the caller can collapse the picker. */
  onDismiss?: () => void;
  /** Skill ids already tagged on the entity — filtered out of results. */
  excludeSkillIds?: readonly string[];
  /** Accessible label / placeholder for the input. */
  label?: string;
  /** Autofocus the input on mount. Defaults to true. */
  autoFocus?: boolean;
}

export function SkillCombobox({
  onSelect,
  onDismiss,
  excludeSkillIds = [],
  label = 'Search skills…',
  autoFocus = true,
}: SkillComboboxProps) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(id);
  }, [query]);

  const { data: results = [] } = useSkillCatalog(debouncedQuery);

  const excluded = useMemo(() => new Set(excludeSkillIds), [excludeSkillIds]);
  const visible = useMemo(
    () => results.filter((s) => !excluded.has(s.id)).slice(0, 20),
    [results, excluded],
  );

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    setActiveIndex(-1);
  }, [debouncedQuery]);

  function handleSelect(skill: Skill) {
    onSelect(skill);
    // Clear so the picker is immediately ready for the next skill.
    setQuery('');
    setDebouncedQuery('');
    setActiveIndex(-1);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, visible.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < visible.length) {
          handleSelect(visible[activeIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onDismiss?.();
        break;
    }
  }

  const dropdownOpen = visible.length > 0;
  const activeOptionId =
    activeIndex >= 0 && activeIndex < visible.length
      ? `${listboxId}-option-${activeIndex}`
      : undefined;

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={dropdownOpen}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        aria-label={label}
        placeholder={label}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full h-8 px-2.5 rounded border border-neutral-border text-xs
          text-neutral-text-primary bg-neutral-surface placeholder:text-neutral-text-disabled
          focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      />

      {dropdownOpen && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Matching skills"
          className="absolute left-0 right-0 top-full mt-1 z-50
            max-h-48 overflow-y-auto
            border border-neutral-border rounded bg-neutral-surface"
        >
          {visible.map((s, i) => (
            <li
              key={s.id}
              id={`${listboxId}-option-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onPointerDown={(e) => {
                e.preventDefault();
                handleSelect(s);
              }}
              className={[
                'px-2.5 py-1.5 text-xs cursor-pointer flex items-center justify-between gap-2',
                i === activeIndex
                  ? 'bg-brand-primary/10 text-brand-primary'
                  : 'text-neutral-text-primary hover:bg-neutral-surface-raised',
              ].join(' ')}
            >
              <span className="truncate">{s.name}</span>
              {s.category && (
                <span className="shrink-0 text-neutral-text-secondary">{s.category}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
