/**
 * The shared Label facet control — one trigger + panel used by the Table/Grid and
 * the Product Backlog (and, once #2384 lands, the Schedule). ADR-0620, #2383.
 *
 * Why this is not `FacetDropdown` (the program-backlog Type/Tags control):
 * that component makes every option its own tab stop and has no room for a
 * per-option count, a panel footer, or an empty-catalog explanation. The design
 * requires all three plus a roving-tabindex/type-ahead keyboard model, and
 * retrofitting FacetDropdown would silently change Type/Tags keyboard behavior on
 * a surface this issue does not touch. So the visual language is shared (the same
 * `FilterChip` trigger, the same `FOCUS_RING`) while the panel is its own.
 *
 * Keyboard model (single tab stop, roving tabindex):
 *   trigger  — Enter/Space/↓ open; ↓ also lands focus on the first option
 *   panel    — ↑↓ move · Home/End jump · Space/Enter toggle *without closing*
 *              (multi-select: results update behind the open panel) · type-ahead
 *              jumps to the next option starting with the typed letter · Esc
 *              closes and returns focus to the trigger · Tab out closes
 *
 * Color is never the only signal: a label's name is rendered next to its swatch
 * in every state — option row, trigger label, and chip (rule 6 / WCAG 1.4.1).
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, Ref, RefObject } from 'react';
import { CheckIcon } from '@/components/Icons';
import { FilterChip } from '@/features/programs/backlog/components/FilterChip';
import { FOCUS_RING } from '@/features/programs/backlog/components/styles';
import { labelDotStyle } from '@/lib/labelColors';
import type { Label } from '@/hooks/useLabels';

/** Above this many labels the panel grows a search field (spec: "exceeds 8"). */
const SEARCH_THRESHOLD = 8;

interface LabelFacetProps {
  /** The project's full label catalog, in palette order. */
  labels: Label[];
  /** Per-label counts over the rows the view has already loaded. */
  counts: Record<string, number>;
  /** Currently selected label ids. */
  selected: string[];
  onChange: (next: string[]) => void;
  /**
   * Navigate to the project's label settings. Rendered only in the
   * empty-catalog state, where it is the user's way out.
   */
  onOpenLabelSettings?: () => void;
  /** Extra controls above `Clear labels` — the Schedule's "Hide non-matching rows". */
  footerExtra?: ReactNode;
  /**
   * Shared with the host's chip strip so removing the last chip can return focus
   * here rather than dropping it on `body`.
   */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

export function LabelFacet({
  labels,
  counts,
  selected,
  onChange,
  onOpenLabelSettings,
  footerExtra,
  triggerRef: externalTriggerRef,
}: LabelFacetProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = externalTriggerRef ?? internalTriggerRef;
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Set by the *keyboard* paths (and only those) to mean "move DOM focus onto the
  // active option". Without this gate, the roving-focus effect also fires when the
  // option list merely changes length — which yanks focus out of the search field
  // after the first keystroke, so the rest of the query is swallowed by the
  // option list's type-ahead instead of narrowing the list.
  const focusActiveRef = useRef(false);
  // Type-ahead buffer, reset after a keystroke pause. A ref (not state) because
  // it must not re-render — it only steers the next focus move.
  const typeAhead = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({
    buffer: '',
    timer: null,
  });

  const isEmptyCatalog = labels.length === 0;
  const searchable = labels.length > SEARCH_THRESHOLD;

  const visible = useMemo(() => {
    if (!searchable || !query.trim()) return labels;
    const q = query.trim().toLowerCase();
    return labels.filter((l) => l.name.toLowerCase().includes(q));
  }, [labels, query, searchable]);

  const close = useCallback(
    (returnFocus: boolean) => {
      setOpen(false);
      setQuery('');
      if (returnFocus) triggerRef.current?.focus();
    },
    [triggerRef],
  );

  // Outside-click and Esc. Esc returns focus to the trigger; an outside click
  // does not steal it back from whatever the user clicked.
  useEffect(() => {
    if (!open) return undefined;
    function onPointer(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) close(false);
    }
    // `globalThis.KeyboardEvent` — the DOM event, not React's synthetic one whose
    // type name is imported above for the JSX handlers.
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
      }
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Move DOM focus to follow the roving index — but only when a keyboard path
  // asked for it (see `focusActiveRef`).
  useEffect(() => {
    if (!open || isEmptyCatalog || !focusActiveRef.current) return;
    focusActiveRef.current = false;
    optionRefs.current[activeIndex]?.focus();
  }, [open, activeIndex, isEmptyCatalog]);

  useEffect(() => {
    const state = typeAhead.current;
    return () => {
      if (state.timer) clearTimeout(state.timer);
    };
  }, []);

  function openPanel(focusFirst: boolean) {
    setOpen(true);
    focusActiveRef.current = focusFirst;
    setActiveIndex(focusFirst ? 0 : -1);
  }

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((v) => v !== id) : [...selected, id]);
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openPanel(true);
    }
  }

  /** Advance the roving index to the next option whose name starts with the
   *  accumulated type-ahead buffer, wrapping past the current position. */
  function seekTypeAhead(char: string) {
    const state = typeAhead.current;
    if (state.timer) clearTimeout(state.timer);
    state.buffer += char.toLowerCase();
    state.timer = setTimeout(() => {
      state.buffer = '';
    }, 600);

    const start = activeIndex + 1;
    for (let i = 0; i < visible.length; i += 1) {
      const idx = (start + i) % visible.length;
      if (visible[idx].name.toLowerCase().startsWith(state.buffer)) {
        moveActive(idx);
        return;
      }
    }
  }

  /** Roving move: remember the intent so the effect above actually moves focus. */
  function moveActive(index: number) {
    focusActiveRef.current = true;
    setActiveIndex(index);
  }

  function onOptionKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number, id: string) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveActive((index + 1) % visible.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive((index - 1 + visible.length) % visible.length);
        break;
      case 'Home':
        e.preventDefault();
        moveActive(0);
        break;
      case 'End':
        e.preventDefault();
        moveActive(visible.length - 1);
        break;
      case ' ':
      case 'Enter':
        // Toggle without closing — the panel is multi-select and the rows behind
        // it update live, which is the whole reason it stays open.
        e.preventDefault();
        toggle(id);
        break;
      case 'Tab':
        close(false);
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          seekTypeAhead(e.key);
        }
    }
  }

  const selectedNames = labels.filter((l) => selected.includes(l.id)).map((l) => l.name);
  let triggerLabel: string;
  if (isEmptyCatalog) triggerLabel = 'Label: none yet';
  else if (selectedNames.length === 0) triggerLabel = 'Label: any';
  else if (selectedNames.length === 1) triggerLabel = `Label: ${selectedNames[0]}`;
  else triggerLabel = `Label: ${selectedNames[0]} +${selectedNames.length - 1}`;

  return (
    <div ref={containerRef} className="relative flex-none">
      <FilterChip
        ref={triggerRef}
        label={triggerLabel}
        caret
        active={selected.length > 0}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openPanel(false))}
        onKeyDown={onTriggerKeyDown}
      />
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Filter by label"
          className="absolute left-0 top-[calc(100%+4px)] z-20 w-[260px] rounded-card border
            border-neutral-border bg-neutral-surface py-1 shadow-pop"
        >
          {isEmptyCatalog ? (
            <EmptyCatalogPanel onOpenLabelSettings={onOpenLabelSettings} />
          ) : (
            <>
              {searchable && (
                <div className="px-2 pb-1">
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setActiveIndex(0);
                    }}
                    placeholder="Filter labels…"
                    aria-label="Filter label options"
                    className={`h-7 w-full rounded-control border border-neutral-border
                      bg-neutral-surface-sunken px-2 text-xs text-neutral-text-primary
                      placeholder:text-neutral-text-secondary ${FOCUS_RING}`}
                  />
                </div>
              )}
              <ul className="max-h-64 overflow-y-auto">
                {visible.length === 0 && (
                  <li className="px-3 py-2 text-xs text-neutral-text-secondary">
                    No labels match that.
                  </li>
                )}
                {visible.map((label, index) => (
                  <li key={label.id}>
                    <LabelOption
                      ref={(el) => {
                        optionRefs.current[index] = el;
                      }}
                      label={label}
                      count={counts[label.id] ?? 0}
                      checked={selected.includes(label.id)}
                      // Roving tabindex: exactly one option is tabbable, so the
                      // whole panel is a single stop in the page tab sequence.
                      tabIndex={index === Math.max(activeIndex, 0) ? 0 : -1}
                      onClick={() => toggle(label.id)}
                      onKeyDown={(e) => onOptionKeyDown(e, index, label.id)}
                    />
                  </li>
                ))}
              </ul>
              <div className="mt-1 flex flex-col gap-1 border-t border-neutral-border px-2 pt-1">
                {footerExtra}
                <button
                  type="button"
                  disabled={selected.length === 0}
                  onClick={() => onChange([])}
                  className={`h-8 rounded-control px-2 text-left text-xs font-medium
                    text-brand-primary hover:bg-neutral-surface-sunken
                    disabled:cursor-not-allowed disabled:text-neutral-text-disabled
                    disabled:hover:bg-transparent ${FOCUS_RING}`}
                >
                  Clear labels
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The empty-catalog panel. The trigger stays present and openable rather than
 * being hidden, because "this project has no labels" is information the user
 * needs — and the panel is where we can say where labels come from. This is
 * discovery copy on the control's own surface, not a rule-231 daily-path
 * padlock advertising a feature the edition does not include.
 */
function EmptyCatalogPanel({ onOpenLabelSettings }: { onOpenLabelSettings?: () => void }) {
  return (
    <div className="px-3 py-2">
      <p className="text-xs font-semibold text-neutral-text-primary">
        No labels in this project yet
      </p>
      <p className="mt-1 text-xs text-neutral-text-secondary">
        Labels are created on a task, or in Project settings → Labels. They&rsquo;re scoped to this
        project.
      </p>
      {onOpenLabelSettings && (
        <button
          type="button"
          onClick={onOpenLabelSettings}
          className={`mt-2 h-8 rounded-control px-2 text-xs font-medium text-brand-primary
            hover:bg-neutral-surface-sunken ${FOCUS_RING}`}
        >
          Open label settings
        </button>
      )}
    </div>
  );
}

interface LabelOptionProps {
  label: Label;
  count: number;
  checked: boolean;
  tabIndex: number;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * One option row: check box · color swatch · name · count. `min-h-11` is the
 * 44px touch target the design calls for; the count is mono/tabular so the
 * column of numbers stays aligned as the panel scrolls.
 */
function LabelOption({
  label,
  count,
  checked,
  tabIndex,
  onClick,
  onKeyDown,
  ref,
}: LabelOptionProps) {
  return (
    <button
      ref={ref}
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      tabIndex={tabIndex}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={`flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left text-xs
        text-neutral-text-primary hover:bg-neutral-surface-raised ${FOCUS_RING}`}
    >
      <span
        aria-hidden="true"
        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${
          checked
            ? 'border-brand-primary bg-brand-primary text-neutral-text-inverse'
            : 'border-neutral-border bg-neutral-surface'
        }`}
      >
        {checked && <CheckIcon className="h-2.5 w-2.5" />}
      </span>
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={labelDotStyle(label.color)}
      />
      <span className="flex-1 truncate">{label.name}</span>
      <span className="tppm-mono shrink-0 text-xs tabular-nums text-neutral-text-secondary">
        {count}
      </span>
    </button>
  );
}
