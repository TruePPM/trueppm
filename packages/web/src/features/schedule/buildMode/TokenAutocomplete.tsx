import { useEffect, useMemo, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** One row in a token type-ahead. */
export interface TokenSuggestion {
  /** Stable key, and the value handed back on select. */
  id: string;
  /** Primary text — what the author is choosing. */
  label: string;
  /** Right-aligned secondary text: a WBS path, a role, the literal it expands to. */
  hint?: string;
}

interface Props {
  suggestions: TokenSuggestion[];
  /** Accessible name for the listbox, e.g. "Set duration". */
  ariaLabel: string;
  onSelect: (suggestion: TokenSuggestion) => void;
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
 * The type-ahead behind every inline authoring token (#2722), so nobody has to
 * memorize the syntax to use it.
 *
 * Portaled to `document.body` and positioned `fixed` via the caller's
 * `useAnchoredPopover` call (#3664, web rule 260) — see `NameAutocomplete`'s
 * header for why an in-flow `absolute` panel could not stay.
 *
 * **Non-modal, and that is the whole contract.** `↑`/`↓` move the selection, `⇥`
 * accepts it, `Esc` dismisses *without touching the text*, and typing past the
 * popover is always allowed — a keystroke that is not one of those four falls
 * straight through to the input. Focus never leaves the row, so there is no entry
 * mode to enter or exit; the popover is a hint surface, never a gate.
 *
 * `Enter` also accepts when a row is actively selected. The documented binding is
 * `⇥`, but `Enter` in the Name cell otherwise means commit-and-continue, and letting
 * it commit a half-typed `@an` while a picker sits open would be worse than accepting
 * the highlighted row. With **no** active selection `Enter` falls through, so a row
 * whose author ignored the popover still commits on the first Enter.
 */
export function TokenAutocomplete({
  suggestions,
  ariaLabel,
  onSelect,
  onDismiss,
  style,
  panelRef,
}: Props) {
  const [activeIdx, setActiveIdx] = useState(-1);
  // Memoized: the keydown effect depends on this array, and a fresh slice on every
  // render would re-register the document listener on every keystroke.
  const matches = useMemo(() => suggestions.slice(0, MAX_SUGGESTIONS), [suggestions]);

  // Reset the highlight whenever the candidate set changes, so a stale index cannot
  // accept a row the author never looked at.
  useEffect(() => {
    setActiveIdx(-1);
  }, [suggestions]);

  // Captured on the document so the popover sees the key before EditableCell's own
  // Enter/Escape/Tab handling — the same interception NameAutocomplete uses.
  useEffect(() => {
    if (matches.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, matches.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, -1));
      } else if (e.key === 'Tab') {
        // Tab accepts. With nothing highlighted the first row is the obvious intent —
        // the author opened a picker and pressed the accept key.
        e.preventDefault();
        e.stopPropagation();
        onSelect(matches[activeIdx >= 0 ? activeIdx : 0]);
      } else if (e.key === 'Enter' && activeIdx >= 0) {
        e.preventDefault();
        e.stopPropagation();
        onSelect(matches[activeIdx]);
      } else if (e.key === 'Escape') {
        // Dismiss only. The draft text is deliberately untouched: the author may have
        // typed something the picker could not offer, and eating it would lose work.
        e.preventDefault();
        e.stopPropagation();
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
      aria-label={ariaLabel}
      style={style}
      className="z-50 rounded-card border border-chrome-border
        bg-chrome-surface-raised overflow-y-auto"
    >
      {matches.map((s, i) => (
        <li
          key={s.id}
          role="option"
          aria-selected={i === activeIdx}
          className={[
            'flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer text-chrome-text-primary',
            i === activeIdx
              ? 'bg-brand-primary/10 text-brand-primary'
              : 'hover:bg-chrome-row-hover',
          ].join(' ')}
          onMouseDown={(e) => {
            // mousedown, not click — it must land before the input's onBlur commits.
            e.preventDefault();
            onSelect(s);
          }}
        >
          <span className="truncate">{s.label}</span>
          {s.hint && (
            <span className="ml-auto shrink-0 text-chrome-text-secondary truncate max-w-[110px]">
              {s.hint}
            </span>
          )}
        </li>
      ))}
    </ul>,
    document.body,
  );
}
