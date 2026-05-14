import { useEffect, useRef, useState } from 'react';

interface Props {
  query: string;
  suggestions: string[];
  onSelect: (value: string) => void;
  onDismiss: () => void;
}

const MAX_SUGGESTIONS = 6;

/**
 * Dropdown autocomplete for the task name cell in build mode (#343).
 * Positioned absolutely below the name input; keyboard-navigable.
 *
 * Design: 280px wide, chrome-surface-raised bg, border border-chrome-border,
 * up to MAX_SUGGESTIONS (6) matches. Suggestions ranked: milestones first
 * (passed ranked from parent), then other names. Filtering is case-insensitive
 * substring match.
 */
export function NameAutocomplete({ query, suggestions, onSelect, onDismiss }: Props) {
  const [activeIdx, setActiveIdx] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);

  const matches =
    query.trim().length === 0
      ? []
      : suggestions
          .filter((s) => s.toLowerCase().includes(query.toLowerCase()))
          .slice(0, MAX_SUGGESTIONS);

  // Reset active index when matches change
  useEffect(() => {
    setActiveIdx(-1);
  }, [matches.length]);

  // Keyboard handler mounted on the document to intercept before EditableCell
  useEffect(() => {
    if (matches.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, matches.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, -1));
      } else if (e.key === 'Enter' && activeIdx >= 0) {
        e.preventDefault();
        e.stopPropagation();
        onSelect(matches[activeIdx]);
      } else if (e.key === 'Escape') {
        onDismiss();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [matches, activeIdx, onSelect, onDismiss]);

  if (matches.length === 0) return null;

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="Task name suggestions"
      className="absolute top-full left-0 z-50 w-[280px] mt-0.5 rounded border border-chrome-border
        bg-chrome-surface-raised overflow-hidden"
    >
      {matches.map((name, i) => (
        <li
          key={name}
          role="option"
          aria-selected={i === activeIdx}
          className={[
            'px-2 py-1.5 text-xs cursor-pointer text-chrome-text-primary truncate',
            i === activeIdx
              ? 'bg-brand-primary/10 text-brand-primary'
              : 'hover:bg-chrome-row-hover',
          ].join(' ')}
          onMouseDown={(e) => {
            // Use mousedown to fire before the input's onBlur
            e.preventDefault();
            onSelect(name);
          }}
        >
          {name}
        </li>
      ))}
    </ul>
  );
}
