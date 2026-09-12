import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  query: string;
  suggestions: string[];
  onSelect: (value: string) => void;
  onDismiss: () => void;
  /**
   * Positioning from the caller's `useAnchoredPopover` call (web rule 260) —
   * the caller owns the trigger (the name cell), so it owns the hook. `null`
   * while closed/unmeasured; the panel does not portal until this is set.
   */
  style: CSSProperties | null;
  /** Attach to the portaled `<ul>` — required for the caller's outside-dismiss span. */
  panelRef: RefObject<HTMLUListElement | null>;
}

const MAX_SUGGESTIONS = 6;

/**
 * Dropdown autocomplete for the task name cell in build mode (#343).
 *
 * Portaled to `document.body` and positioned `fixed` via `useAnchoredPopover`
 * (#3664) — the outline row that hosts this cell renders inside
 * `TaskListPanel`'s `overflow-x-hidden overflow-y-auto` virtualized scroll
 * wrapper, so an in-flow `absolute` panel wider than the ~268px Timeline
 * outline column was clipped on the right with nothing to scroll it into view
 * (the same class of bug #3663 fixed for the session-trail popover).
 *
 * Design: 280px wide, chrome-surface-raised bg, border border-chrome-border,
 * up to MAX_SUGGESTIONS (6) matches. Suggestions ranked: milestones first
 * (passed ranked from parent), then other names. Filtering is case-insensitive
 * substring match.
 */
export function NameAutocomplete({
  query,
  suggestions,
  onSelect,
  onDismiss,
  style,
  panelRef,
}: Props) {
  const [activeIdx, setActiveIdx] = useState(-1);

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

  if (matches.length === 0 || !style) return null;

  return createPortal(
    <ul
      ref={panelRef}
      role="listbox" // dropdown-scroll-ok: hard-capped slice(0, MAX_SUGGESTIONS)
      aria-label="Task name suggestions"
      style={style}
      className="z-50 rounded-card border border-chrome-border
        bg-chrome-surface-raised overflow-y-auto"
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
    </ul>,
    document.body,
  );
}
