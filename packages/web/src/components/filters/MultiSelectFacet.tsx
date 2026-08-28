/**
 * The shared multi-select facet control — one trigger + one panel, used by the
 * Grid's Owner, Status and Label facets. ADR-0624, issue #2387.
 *
 * #2383 built this keyboard model once, inside `LabelFacet`. #2387 adds two more
 * facets to the same toolbar, and the design's whole premise is that the three
 * read as one coherent set: same trigger, same panel, same chip, same keys. So
 * the machinery moved here and `LabelFacet` / `OwnerFacet` / `StatusFacet` are
 * now thin wrappers that supply options and copy. Three copies of a roving
 * tabindex would have drifted within one release.
 *
 * Why this is still not `FacetDropdown` (the program-backlog Type/Tags control):
 * that component makes every option its own tab stop and has no room for a
 * per-option count, a grouped list, a panel footer, or an empty-catalog
 * explanation. Retrofitting it would silently change Type/Tags keyboard
 * behavior on a surface this issue does not touch. The visual language is
 * shared (`FilterChip` trigger, `FOCUS_RING`); the panel is our own.
 *
 * Keyboard model (single tab stop per facet, roving tabindex inside):
 *   trigger  — Enter/Space/↓ open; ↓ also lands focus on the first option
 *   search   — ↓ enters the option list; the field itself keeps normal text keys
 *   options  — ↑↓ move · Home/End jump · Space/Enter toggle *without closing*
 *              (results update live behind the open panel) · type-ahead jumps to
 *              the next option starting with the typed letters · ↑ from the first
 *              option returns to the search field · Esc closes and returns focus
 *              to the trigger · Tab closes and continues to the next trigger
 *
 * ←/→ deliberately do NOT move between the three triggers: they would fight the
 * text cursor in the toolbar's search input, which sits in the same tab order.
 * Each facet is its own tab stop instead.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, Ref, RefObject } from 'react';
import { CheckIcon } from '@/components/Icons';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { FilterChip } from '@/features/programs/backlog/components/FilterChip';
import { FOCUS_RING } from '@/features/programs/backlog/components/styles';

/** Above this many options the panel grows a search field. */
export const SEARCH_THRESHOLD = 8;

/**
 * Scroll cap for the option list: 6.5 × 44px rows. The half row is deliberate —
 * a list clipped mid-row reads as scrollable, where a clean cut at a row
 * boundary reads as complete.
 */
const LIST_MAX_HEIGHT = '286px';

export interface FacetOptionItem {
  /** Opaque id; what goes in the URL and in `selected`. */
  id: string;
  /** Human name. Always rendered — a swatch/avatar is never the only cue. */
  name: string;
  /** Rows matching this option in the loaded set. `0` is shown, not hidden. */
  count: number;
  /** Optional decoration before the name (swatch, avatar, status dot). */
  leading?: ReactNode;
}

export interface FacetOptionGroup {
  key: string;
  /** Group heading, e.g. `On these rows · 6`. Omitted for a single flat group. */
  heading?: string;
  options: FacetOptionItem[];
}

interface MultiSelectFacetProps {
  /** Trigger text, e.g. `Owner: A. Reyes +1`. Built by the wrapper. */
  triggerLabel: string;
  /** Accessible name for the panel, e.g. `Filter by owner`. */
  menuLabel: string;
  groups: FacetOptionGroup[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Footer action text, e.g. `Clear owners`. */
  clearLabel: string;
  /** Muted footer line explaining the facet's semantics, e.g. `Any of the
   *  selected owners`. Present on all three so OR-within is never a guess. */
  footerHint?: string;
  /** Extra footer controls above the clear action (the Schedule's
   *  "Hide non-matching rows", #2384). */
  footerExtra?: ReactNode;
  /** Replaces the whole panel body when there is nothing to choose from. */
  emptyPanel?: ReactNode;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  /** Copy for a search that matches nothing, e.g. `No owners match that.` */
  noMatchLabel?: string;
  /** Shared with the host's chip strip so removing the last chip of this facet
   *  can return focus here rather than dropping it on `body`. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /**
   * Controlled open state. The Grid owns it so opening Status closes Owner —
   * "one panel at a time", no stacking, no scrim on desktop.
   */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * `sheet` renders the same panel body inside a `BottomSheet` (≤768px). The
   * options, counts, grouping and footer are identical — only the container
   * changes, so a phone user and a desktop user are choosing from the same list.
   */
  presentation?: 'popover' | 'sheet';
}

export function MultiSelectFacet({
  triggerLabel,
  menuLabel,
  groups,
  selected,
  onChange,
  clearLabel,
  footerHint,
  footerExtra,
  emptyPanel,
  searchPlaceholder = 'Filter options…',
  searchAriaLabel = 'Filter options',
  noMatchLabel = 'Nothing matches that.',
  triggerRef: externalTriggerRef,
  open,
  onOpenChange,
  presentation = 'popover',
}: MultiSelectFacetProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const menuId = useId();
  const sheetTitleId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = externalTriggerRef ?? internalTriggerRef;
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Set by the *keyboard* paths (and only those) to mean "move DOM focus onto
  // the active option". Without this gate the roving-focus effect also fires
  // when the option list merely changes length — which yanks focus out of the
  // search field after the first keystroke, so the rest of the query is
  // swallowed by the option list's type-ahead instead of narrowing the list
  // (web rule 280, the regression #2383 shipped a fix for).
  const focusActiveRef = useRef(false);
  const typeAhead = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({
    buffer: '',
    timer: null,
  });

  const totalOptions = useMemo(
    () => groups.reduce((n, g) => n + g.options.length, 0),
    [groups],
  );
  const isEmpty = totalOptions === 0;
  const searchable = totalOptions > SEARCH_THRESHOLD;

  // Typing filters every group at once — a name you half-remember shouldn't
  // require knowing which group it lives in. Empty groups drop out entirely so
  // the heading never sits above nothing.
  const visibleGroups = useMemo(() => {
    if (!searchable || !query.trim()) return groups.filter((g) => g.options.length > 0);
    const q = query.trim().toLowerCase();
    return groups
      .map((g) => ({ ...g, options: g.options.filter((o) => o.name.toLowerCase().includes(q)) }))
      .filter((g) => g.options.length > 0);
  }, [groups, query, searchable]);

  /** Options flattened in render order — the roving index addresses this. */
  const flat = useMemo(() => visibleGroups.flatMap((g) => g.options), [visibleGroups]);

  const close = useCallback(
    (returnFocus: boolean) => {
      onOpenChange(false);
      setQuery('');
      if (returnFocus) triggerRef.current?.focus();
    },
    [onOpenChange, triggerRef],
  );

  // Outside-click and Esc. Esc returns focus to the trigger; an outside click
  // does not steal it back from whatever the user clicked. The sheet brings its
  // own scrim and dismissal, so this only applies to the popover.
  useEffect(() => {
    if (!open || presentation === 'sheet') return undefined;
    function onPointer(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) close(false);
    }
    // `globalThis.KeyboardEvent` — the DOM event, not React's synthetic one
    // whose type name is imported above for the JSX handlers.
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
  }, [open, close, presentation]);

  // Move DOM focus to follow the roving index — but only when a keyboard path
  // asked for it (see `focusActiveRef`).
  useEffect(() => {
    if (!open || isEmpty || !focusActiveRef.current) return;
    focusActiveRef.current = false;
    optionRefs.current[activeIndex]?.focus();
  }, [open, activeIndex, isEmpty]);

  useEffect(() => {
    const state = typeAhead.current;
    return () => {
      if (state.timer) clearTimeout(state.timer);
    };
  }, []);

  function openPanel(focusFirst: boolean) {
    onOpenChange(true);
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

  /** Roving move: remember the intent so the effect above actually moves focus. */
  function moveActive(index: number) {
    focusActiveRef.current = true;
    setActiveIndex(index);
  }

  /** Advance to the next option whose name starts with the accumulated
   *  type-ahead buffer, wrapping past the current position. */
  function seekTypeAhead(char: string) {
    const state = typeAhead.current;
    if (state.timer) clearTimeout(state.timer);
    state.buffer += char.toLowerCase();
    state.timer = setTimeout(() => {
      state.buffer = '';
    }, 600);

    const start = activeIndex + 1;
    for (let i = 0; i < flat.length; i += 1) {
      const idx = (start + i) % flat.length;
      if (flat[idx].name.toLowerCase().startsWith(state.buffer)) {
        moveActive(idx);
        return;
      }
    }
  }

  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && flat.length > 0) {
      e.preventDefault();
      moveActive(0);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close(true);
    }
  }

  function onOptionKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number, id: string) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveActive((index + 1) % flat.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        // From the first row, ↑ goes back up to the search field rather than
        // wrapping to the bottom — the field is visually above the list, and a
        // wrap there strands anyone trying to correct a typo.
        if (index === 0 && searchable && searchRef.current) {
          searchRef.current.focus();
        } else {
          moveActive((index - 1 + flat.length) % flat.length);
        }
        break;
      case 'Home':
        e.preventDefault();
        moveActive(0);
        break;
      case 'End':
        e.preventDefault();
        moveActive(flat.length - 1);
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

  // Index counter threaded through the grouped render so the roving index and
  // `optionRefs` address the same flattened order the keyboard walks.
  let flatIndex = -1;

  const body = isEmpty ? (
    emptyPanel
  ) : (
    <>
      {searchable && (
        <div className="px-2 pb-1">
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onSearchKeyDown}
            placeholder={searchPlaceholder}
            aria-label={searchAriaLabel}
            className={`h-7 w-full rounded-control border border-neutral-border
              bg-neutral-surface-sunken px-2 text-xs text-neutral-text-primary
              placeholder:text-neutral-text-secondary ${FOCUS_RING}`}
          />
        </div>
      )}
      <div className="overflow-y-auto" style={{ maxHeight: LIST_MAX_HEIGHT }}>
        {flat.length === 0 && (
          <p className="px-3 py-2 text-xs text-neutral-text-secondary">{noMatchLabel}</p>
        )}
        {visibleGroups.map((group) => (
          <div key={group.key} role="group" aria-label={group.heading ?? menuLabel}>
            {group.heading && (
              <p
                aria-hidden="true"
                className="px-3 pb-0.5 pt-2 text-xs font-semibold uppercase tracking-wide
                  text-neutral-text-secondary"
              >
                {group.heading}
              </p>
            )}
            <ul role="none">
              {group.options.map((option) => {
                flatIndex += 1;
                const index = flatIndex;
                return (
                  <li key={option.id} role="none">
                    <FacetOptionRow
                      ref={(el) => {
                        optionRefs.current[index] = el;
                      }}
                      option={option}
                      checked={selected.includes(option.id)}
                      // Roving tabindex: exactly one option is tabbable, so the
                      // whole panel is a single stop in the page tab sequence.
                      tabIndex={index === Math.max(activeIndex, 0) ? 0 : -1}
                      onClick={() => toggle(option.id)}
                      onKeyDown={(e) => onOptionKeyDown(e, index, option.id)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="mt-1 flex flex-col gap-1 border-t border-neutral-border px-2 pt-1">
        {footerHint && (
          <p className="px-1 pt-0.5 text-xs text-neutral-text-secondary">{footerHint}</p>
        )}
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
          {clearLabel}
        </button>
      </div>
    </>
  );

  const trigger = (
    <FilterChip
      ref={triggerRef}
      label={triggerLabel}
      caret
      active={selected.length > 0}
      aria-haspopup={presentation === 'sheet' ? 'dialog' : 'menu'}
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      onClick={() => (open ? close(false) : openPanel(false))}
      onKeyDown={onTriggerKeyDown}
    />
  );

  if (presentation === 'sheet') {
    return (
      <div ref={containerRef} className="relative flex-none">
        {trigger}
        <BottomSheet
          isOpen={open}
          onClose={() => close(true)}
          titleId={sheetTitleId}
          size="large"
          mobileOnly={false}
        >
          <div id={menuId} className="flex h-full flex-col px-2 pb-[env(safe-area-inset-bottom)]">
            <div className="flex items-center justify-between px-1 py-2">
              <h2 id={sheetTitleId} className="text-sm font-semibold text-neutral-text-primary">
                {menuLabel}
              </h2>
              {/* "Done" dismisses; it does not *apply*. Selections are already
                  live behind the sheet, matching the desktop panel — there is
                  no Apply button and no working copy to commit. */}
              <button
                type="button"
                onClick={() => close(true)}
                className={`h-9 rounded-control px-3 text-xs font-semibold text-brand-primary
                  ${FOCUS_RING}`}
              >
                Done
              </button>
            </div>
            {body}
          </div>
        </BottomSheet>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative flex-none">
      {trigger}
      {open && (
        <div
          id={menuId}
          role="menu" // dropdown-scroll-ok: wraps {body}, which already carries its own overflow-y-auto + maxHeight: LIST_MAX_HEIGHT guard
          aria-label={menuLabel}
          className="absolute left-0 top-[calc(100%+4px)] z-20 w-[260px] rounded-card border
            border-neutral-border bg-neutral-surface py-1 shadow-pop"
        >
          {body}
        </div>
      )}
    </div>
  );
}

interface FacetOptionRowProps {
  option: FacetOptionItem;
  checked: boolean;
  tabIndex: number;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * One option row: check box · optional decoration · name · count. `min-h-11` is
 * the 44px touch target the design calls for; the count is mono/tabular so the
 * column of numbers stays aligned as the panel scrolls.
 *
 * The list is capped and scrolled rather than virtualised, deliberately:
 * virtualising a roving-tabindex list unmounts the focused option the moment it
 * scrolls out of the window, which drops focus to `body` mid-keyboard-walk. At
 * the roster sizes this control sees (tens of members, not thousands) the DOM
 * cost is nil and the focus contract is worth more.
 */
function FacetOptionRow({ option, checked, tabIndex, onClick, onKeyDown, ref }: FacetOptionRowProps) {
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
      {option.leading}
      <span className="flex-1 truncate">{option.name}</span>
      <span className="tppm-mono shrink-0 text-xs tabular-nums text-neutral-text-secondary">
        {option.count}
      </span>
    </button>
  );
}
