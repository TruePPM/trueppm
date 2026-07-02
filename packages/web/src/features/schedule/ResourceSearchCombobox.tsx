import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useResourceSearch } from '@/hooks/useResourceSearch';
import { useSkillFitSearch } from '@/hooks/useSkillFitSearch';
import { SkillChip } from '@/features/roster/SkillChip';
import type { ResourceWithSkillFit } from '@/types';

export interface ResourceSearchComboboxProps {
  onSelect: (resourceId: string, resourceName: string) => void;
  onDismiss: () => void;
  /**
   * When provided, the combobox fetches skill-fit annotations for this task
   * and groups results into Best fit / Partial fit / No skill match.
   */
  taskId?: string;
}

export function ResourceSearchCombobox({ onSelect, onDismiss, taskId }: ResourceSearchComboboxProps) {
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
  const flatSearch = useResourceSearch(debouncedQuery);
  const fitSearch = useSkillFitSearch(debouncedQuery, taskId ?? '');

  const isSkillMode = Boolean(taskId);

  // Flat list of options (for non-skill mode and for keyboard index tracking).
  const flatResults = flatSearch.data?.slice(0, 20) ?? [];
  const fitResults = fitSearch.data ?? { exact: [], partial: [], missing: [] };

  // Build a flat ordered list for keyboard nav: exact → partial → missing.
  const skillGroups: { label: string; items: ResourceWithSkillFit[] }[] = isSkillMode
    ? [
        { label: 'Best fit', items: fitResults.exact },
        { label: 'Partial fit', items: fitResults.partial },
        { label: 'No skill match', items: fitResults.missing },
      ].filter((g) => g.items.length > 0)
    : [];

  const flatSkillItems: ResourceWithSkillFit[] = [
    ...fitResults.exact,
    ...fitResults.partial,
    ...fitResults.missing,
  ];

  const totalCount = isSkillMode ? flatSkillItems.length : flatResults.length;

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
        setActiveIndex((prev) => Math.min(prev + 1, totalCount - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0) {
          if (isSkillMode) {
            const r = flatSkillItems[activeIndex];
            if (r) onSelect(r.id, r.name);
          } else {
            const r = flatResults[activeIndex];
            if (r) onSelect(r.id, r.name);
          }
        }
        break;
      case 'Escape':
        e.preventDefault();
        onDismiss();
        break;
    }
  }

  const activeOptionId =
    activeIndex >= 0 && activeIndex < totalCount
      ? `${listboxId}-option-${activeIndex}`
      : undefined;

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={totalCount > 0}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        aria-label="Search resources"
        placeholder="Search resources…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full text-xs border border-neutral-border rounded-control px-2 py-1
          bg-neutral-surface text-neutral-text-primary placeholder:text-neutral-text-disabled
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      />

      {totalCount > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Resource options"
          className="absolute left-0 right-0 top-full mt-1 z-50
            max-h-56 overflow-y-auto
            border border-neutral-border rounded-card
            bg-neutral-surface-raised"
        >
          {isSkillMode ? (
            <SkillGroupedOptions
              groups={skillGroups}
              flatItems={flatSkillItems}
              activeIndex={activeIndex}
              listboxId={listboxId}
              onSelect={onSelect}
            />
          ) : (
            flatResults.map((r, i) => (
              <li
                key={r.id}
                id={`${listboxId}-option-${i}`}
                role="option"
                aria-selected={i === activeIndex}
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
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skill-grouped options
// ---------------------------------------------------------------------------

interface SkillGroupedOptionsProps {
  groups: { label: string; items: ResourceWithSkillFit[] }[];
  flatItems: ResourceWithSkillFit[];
  activeIndex: number;
  listboxId: string;
  onSelect: (id: string, name: string) => void;
}

function SkillGroupedOptions({
  groups,
  flatItems,
  activeIndex,
  listboxId,
  onSelect,
}: SkillGroupedOptionsProps) {
  return (
    <>
      {groups.map((group) => (
        <li key={group.label} role="presentation">
          {/* Group header — not a listbox option */}
          <div
            role="presentation"
            className="px-2 py-1 text-xs font-semibold tracking-widest uppercase
              text-neutral-text-disabled bg-neutral-surface-raised border-b border-neutral-border"
          >
            {group.label}
          </div>
          <ul role="presentation">
            {group.items.map((r) => {
              const idx = flatItems.indexOf(r);
              const isActive = idx === activeIndex;
              return (
                <li
                  key={r.id}
                  id={`${listboxId}-option-${idx}`}
                  role="option"
                  aria-selected={isActive}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    onSelect(r.id, r.name);
                  }}
                  className={[
                    'px-2 py-1.5 text-xs cursor-pointer flex flex-col gap-1',
                    'text-neutral-text-primary',
                    isActive ? 'bg-brand-primary/10' : 'hover:bg-neutral-surface',
                  ].join(' ')}
                >
                  <span className="font-medium">{r.name}</span>
                  <div className="flex flex-wrap gap-1">
                    {r.skills.slice(0, 4).map((s) => (
                      <SkillChip key={s.id} name={s.skill.name} proficiency={s.proficiency} />
                    ))}
                    {r.missingSkills.slice(0, 2).map((ms) => (
                      <SkillChip
                        key={ms.skillId}
                        name={`Missing: ${ms.skillName}`}
                        missing
                      />
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </>
  );
}
