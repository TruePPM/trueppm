/**
 * Multi-select facet dropdown for the Type and Tags toolbar filters. The
 * trigger reuses `FilterChip` (caret variant) so it shares the chips' visual
 * language; the menu is a checkbox list (AND semantics within a facet).
 *
 * Closes on outside-click and Esc (focus returns to the trigger). Tags become
 * searchable when the option list is long.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { FilterChip } from './FilterChip';
import { FOCUS_RING } from './styles';

export interface FacetOption {
  value: string;
  label: string;
}

interface FacetDropdownProps {
  label: string;
  options: FacetOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchable?: boolean;
}

export function FacetDropdown({
  label,
  options,
  selected,
  onChange,
  searchable = false,
}: FacetDropdownProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointer(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectedLabels = options.filter((o) => selected.includes(o.value)).map((o) => o.label);
  const triggerLabel =
    selectedLabels.length === 0
      ? `${label}: any`
      : selectedLabels.length === 1
        ? `${label}: ${selectedLabels[0]}`
        : `${label}: ${selectedLabels[0]} +${selectedLabels.length - 1}`;

  const visibleOptions = searchable
    ? options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()))
    : options;

  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }

  return (
    <div ref={containerRef} className="relative">
      <FilterChip
        ref={triggerRef}
        label={triggerLabel}
        caret
        active={selected.length > 0}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`Filter by ${label.toLowerCase()}`}
          className="absolute left-0 top-[calc(100%+4px)] z-20 min-w-[200px] rounded-md border border-neutral-border bg-neutral-surface py-1"
        >
          {searchable && (
            <div className="px-2 pb-1">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`Filter ${label.toLowerCase()}…`}
                aria-label={`Filter ${label.toLowerCase()} options`}
                className={`h-7 w-full rounded border border-neutral-border bg-neutral-surface-sunken px-2 text-xs text-neutral-text-primary placeholder:text-neutral-text-secondary ${FOCUS_RING}`}
              />
            </div>
          )}
          <ul className="max-h-64 overflow-y-auto">
            {visibleOptions.length === 0 && (
              <li className="px-3 py-1.5 text-xs text-neutral-text-secondary">No matches</li>
            )}
            {visibleOptions.map((option) => {
              const checked = selected.includes(option.value);
              return (
                <li key={option.value}>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    onClick={() => toggle(option.value)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-text-primary hover:bg-neutral-surface-raised ${FOCUS_RING}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border text-xs ${
                        checked
                          ? 'border-brand-primary bg-brand-primary text-white'
                          : 'border-neutral-border bg-neutral-surface'
                      }`}
                    >
                      {checked ? '✓' : ''}
                    </span>
                    {option.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
