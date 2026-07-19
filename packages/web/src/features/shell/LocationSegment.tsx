import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router';
import type { LocationSegmentOption } from './useLocationModel';

interface Props {
  /** Grammatical noun for the aria labels + empty row ("program" | "project"). */
  noun: string;
  /** The switchable options; when fewer than two, the segment renders a static
   *  identity row (there is nothing to switch to — rule 124: no dead chevron). */
  options: LocationSegmentOption[];
  /** The active option's id, used to mark it selected and seed the highlight. */
  currentId: string | undefined;
  /** The active option's display name (shown in the trigger / static row). */
  currentName: string | undefined;
  /** Optional leading mark (e.g. a `ProgramIdentitySquare`) — always `aria-hidden`;
   *  the name is the signal (rules 6/7/158). */
  leading?: ReactNode;
  /** Optional subtitle shown as a second line on the CURRENT (selected) option row
   *  only (#1680 — the project segment passes the methodology label here). Other
   *  rows and other segments (e.g. program) stay single-line. */
  currentSubtitle?: string;
  /** Placeholder-picker mode (#2102, ADR-0508 D3): when `currentId` is undefined
   *  the trigger shows this visible label (e.g. "Jump to project…") instead of a
   *  current name. Ignored while a current exists. */
  placeholder?: string;
  /** Accessible name for the trigger + listbox in placeholder mode (e.g. "Jump to
   *  a project") — the `Switch ${noun}` fallback implies a current one exists. */
  placeholderAriaLabel?: string;
}

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      className="shrink-0 text-brand-primary"
      aria-hidden="true"
    >
      <path
        d="M3 8l3.5 3.5L13 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/**
 * One interactive segment of the top-bar location switcher (issue #1643) — the
 * generalized, reusable form of the former in-chrome `ProjectSwitcher`. Given a
 * list of switchable locations it renders either:
 *
 *   - a **searchable picker** (≥ 2 options) — the rule-124 contract: a `combobox`
 *     search input + `role="listbox"` of `role="option"` rows, case-insensitive
 *     substring filter, `aria-activedescendant` highlight, arrows/Home/End/Enter,
 *     two-stage Escape, `role="status"` empty row, click-outside dismiss, and focus
 *     that returns to the trigger on close; or
 *   - a **static identity row** (≤ 1 option, current present) — the name as plain,
 *     non-focusable text with no chevron, because there is nothing to switch to (a
 *     chevron that opens an empty list is a dead affordance). This is the
 *     wayfinding-still-shown guarantee the old `ProjectSwitcher` lacked (it
 *     returned null below two); or
 *   - a **placeholder picker** (no `currentId` — #2102, ADR-0508 D3) — the same
 *     searchable picker anchored by a `placeholder` label ("Jump to project…"),
 *     rendered even with a single option: with no current, every option is a
 *     destination, so the static-row shortcut never applies. The caller omits the
 *     segment entirely at zero options.
 *
 * Selecting an option navigates to its `to` (which the caller composes to preserve
 * the active view segment). Choosing the current option is a no-op close.
 */
export function LocationSegment({
  noun,
  options,
  currentId,
  currentName,
  leading,
  currentSubtitle,
  placeholder,
  placeholderAriaLabel,
}: Props) {
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, query]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Click-outside dismiss (no focus return — the user looked elsewhere).
  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
      setQuery('');
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [open]);

  // On open: focus the search input and seed the highlight to the current option.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const idx = options.findIndex((o) => o.id === currentId);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [open, options, currentId]);

  // Keep the highlight in range as the filtered set shrinks; scroll it into view.
  useEffect(() => {
    if (!open) return;
    if (activeIndex > filtered.length - 1) {
      setActiveIndex(filtered.length > 0 ? filtered.length - 1 : 0);
    } else {
      optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [open, activeIndex, filtered.length]);

  const handleSelect = useCallback(
    (opt: LocationSegmentOption) => {
      if (opt.id !== currentId) void navigate(opt.to);
      close(true);
    },
    [currentId, navigate, close],
  );

  function handleInputKeyDown(e: KeyboardEvent) {
    const n = filtered.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n) setActiveIndex((i) => (i + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setActiveIndex((i) => (i - 1 + n) % n);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(Math.max(0, n - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[activeIndex];
      if (opt) handleSelect(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Two-stage: clear a non-empty query first, then close.
      if (query) {
        setQuery('');
        setActiveIndex(0);
      } else {
        close(true);
      }
    }
  }

  // Placeholder-picker mode (#2102, ADR-0508 D3): no current AND a placeholder was
  // supplied — the segment is a pure "jump into a ${noun}" affordance, so trigger +
  // listbox take the placeholder accessible name (never "Switch …", which implies a
  // current). Gating on `placeholder` (not `currentId` alone) keeps a caller that
  // omits it — e.g. the program segment mid-load, `currentId` transiently undefined
  // — on its original static-row/`Switch …` behavior, so this branch only ever
  // affects segments that opted in.
  const isPlaceholder = currentId === undefined && placeholder !== undefined;
  const pickerAriaLabel =
    isPlaceholder && placeholderAriaLabel ? placeholderAriaLabel : `Switch ${noun}`;

  // Static identity row — nothing to switch to (rule 124: no chevron, not a button).
  // Still shows the name so wayfinding is never lost. Applies only when a current
  // exists: in placeholder mode even a single option renders the picker (#2102) —
  // the segment's whole job there is jumping, and a static placeholder that opens
  // nothing would be the dead affordance rule 124 forbids.
  if (options.length < 2 && !isPlaceholder) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-sm font-medium text-chrome-text-secondary">
        {leading}
        {currentName && <span className="hidden truncate lg:inline">{currentName}</span>}
      </span>
    );
  }

  return (
    <div className="relative shrink-0" ref={popoverRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          currentName ? `Current ${noun}: ${currentName}. Switch ${noun}.` : pickerAriaLabel
        }
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-[11rem] items-center gap-1.5 h-8 px-2 rounded-control text-sm font-medium text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface"
      >
        {leading}
        {currentName ? (
          <span className="hidden truncate lg:inline">{currentName}</span>
        ) : (
          // The placeholder is the segment's only label, so unlike a current name
          // it never hides below lg — a bare chevron would be unguessable.
          isPlaceholder && placeholder && <span className="truncate">{placeholder}</span>
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          className={`shrink-0 text-neutral-text-disabled transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        >
          <path
            d="M6 4l4 4-4 4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-64 rounded-card border border-neutral-border bg-chrome-surface">
          {/* Search box — always present. focus-within (not focus-visible) so the
              programmatic open-focus shows a ring too (rule 157). */}
          <div className="flex items-center gap-1.5 px-2 h-8 border-b border-neutral-border focus-within:ring-2 focus-within:ring-inset focus-within:ring-brand-primary">
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              className="shrink-0 text-neutral-text-disabled"
              aria-hidden="true"
            >
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
              <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={filtered[activeIndex] ? optionId(activeIndex) : undefined}
              aria-label={`Find a ${noun}`}
              placeholder={`Find a ${noun}…`}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleInputKeyDown}
              className="flex-1 min-w-0 bg-transparent text-xs text-neutral-text-primary placeholder:text-neutral-text-disabled focus:outline-none"
            />
          </div>

          <div
            id={listboxId}
            role="listbox"
            aria-label={pickerAriaLabel}
            className="max-h-64 overflow-y-auto py-1"
          >
            {filtered.length === 0 ? (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center px-2 h-8 text-xs text-neutral-text-secondary"
              >
                No {noun}s match
              </div>
            ) : (
              filtered.map((opt, i) => {
                const isCurrent = opt.id === currentId;
                const isHighlighted = i === activeIndex;
                // The current row grows to two lines when a subtitle is supplied
                // (#1680); its accessible name folds the subtitle in so the extra
                // line isn't read as a stray text node.
                const showSubtitle = isCurrent && Boolean(currentSubtitle);
                return (
                  <button
                    key={opt.id}
                    id={optionId(i)}
                    ref={(el) => {
                      optionRefs.current[i] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    aria-label={
                      showSubtitle
                        ? `${opt.name}, current, ${currentSubtitle} workspace`
                        : undefined
                    }
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => handleSelect(opt)}
                    className={`w-full flex items-center gap-1.5 px-2 ${showSubtitle ? 'py-1' : 'h-8'} text-xs text-left text-neutral-text-primary ${isHighlighted ? 'bg-neutral-surface-sunken' : ''}`}
                  >
                    {showSubtitle ? (
                      <span className="min-w-0 flex-1 flex flex-col">
                        <span className="truncate">{opt.name}</span>
                        <span className="truncate text-xs text-neutral-text-secondary">
                          {currentSubtitle} workspace
                        </span>
                      </span>
                    ) : (
                      <span className="flex-1 truncate">{opt.name}</span>
                    )}
                    {isCurrent && <CheckIcon />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
