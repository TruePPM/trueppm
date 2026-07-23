/**
 * Controlled value-select combobox (web-rule 160, #966).
 *
 * A PURE, controlled primitive: it fetches nothing and mutates nothing. The
 * caller supplies `options` (from its own data hook) and a `value`; selection
 * emits `onChange` only. On a settings page this sets the page's field state so
 * the rule-115 save bar commits — never a direct PATCH (the deliberate opposite
 * of `AddToRosterCombobox`, which mutates immediately because it has no save bar).
 *
 * Implements the rule-124 searchable-listbox contract verbatim (combobox input +
 * role=listbox/option, aria-activedescendant, case-insensitive substring filter,
 * arrows/Home/End/Enter, two-stage Escape, role=status rows, focus returns to
 * trigger), the rule-157 focus-within ring on the icon-prefixed search box, and
 * the rule-6 aria-hidden avatar / accessible-name-is-the-text split. A nullable
 * value exposes a pinned "Unassign" row at index 0 (exempt from the text filter,
 * carries the checkmark when value is null) — never a separate footer button.
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';

export interface EntityOption {
  id: string;
  primaryText: string;
  secondaryText?: string;
  /** 1–2 char initials for the aria-hidden avatar dot. */
  initials: string;
}

interface EntitySelectComboboxProps {
  value: string | null;
  options: EntityOption[];
  onChange: (id: string | null) => void;
  /** Names the listbox + drives the search placeholder, e.g. "project lead". */
  label: string;
  nullable?: boolean;
  unassignLabel?: string;
  isLoading?: boolean;
  /** Render-gate: when true, the value renders as static text with no trigger. */
  disabled?: boolean;
  triggerLabel?: { set: string; unset: string };
}

function Avatar({ initials }: { initials: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-primary text-xs font-bold text-neutral-text-inverse"
    >
      {initials}
    </span>
  );
}

export function EntitySelectCombobox({
  value,
  options,
  onChange,
  label,
  nullable = true,
  unassignLabel = 'Unassigned',
  isLoading = false,
  disabled = false,
  triggerLabel = { set: 'Change', unset: 'Assign' },
}: EntitySelectComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Portal + flip/clamp the panel so the fixed 260px dropdown never overflows the
  // right edge on a phone (or inside the narrow TransferOwnershipDialog modal) and
  // escapes the settings scroll panel (web-rule 253, #1966). Anchored to the row
  // container so it keeps dropping from the left of the identity row.
  const {
    triggerRef: anchorRef,
    popoverRef,
    popoverStyle,
  } = useAnchoredPopover<HTMLDivElement, HTMLDivElement>({
    open,
    width: 260,
    estimatedHeight: 260,
    onDismiss: () => {
      setOpen(false);
      setQuery('');
    },
  });

  const selected = useMemo(() => options.find((o) => o.id === value) ?? null, [options, value]);

  // The navigable rows: a pinned Unassign sentinel (id === null) when nullable,
  // followed by the substring-filtered options. Unassign is exempt from the filter
  // so the value can always be cleared regardless of the query.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? options.filter((o) => o.primaryText.toLowerCase().includes(q)) : options;
    const list: Array<{ id: string | null; option: EntityOption | null }> = filtered.map((o) => ({
      id: o.id,
      option: o,
    }));
    if (nullable) list.unshift({ id: null, option: null });
    return list;
  }, [options, query, nullable]);

  // On open, seed the highlight to the current selection's row and focus the input.
  useEffect(() => {
    if (!open) return;
    const idx = rows.findIndex((r) => r.id === value);
    setActiveIndex(idx >= 0 ? idx : 0);
    inputRef.current?.focus();
    // Intentionally only on open — typing recomputes activeIndex in the handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Click-outside dismissal is owned by useAnchoredPopover (its check spans the
  // anchor row + the portaled panel, which are no longer DOM-nested).

  function commit(index: number) {
    const row = rows[index];
    if (!row) return;
    onChange(row.id);
    setOpen(false);
    setQuery('');
    triggerRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => (rows.length ? (i + 1) % rows.length : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(Math.max(0, rows.length - 1));
        break;
      case 'Enter':
        e.preventDefault();
        if (rows.length) commit(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        // Two-stage: clear a non-empty query first, then close.
        if (query) {
          setQuery('');
          setActiveIndex(0);
        } else {
          setOpen(false);
          triggerRef.current?.focus();
        }
        break;
    }
  }

  // Read-only render-gate (rule 156 precedent): static value, no trigger.
  if (disabled) {
    return (
      <span className="inline-flex items-center gap-2">
        {selected ? (
          <>
            <Avatar initials={selected.initials} />
            <span className="text-[13px] font-medium text-neutral-text-primary">
              {selected.primaryText}
            </span>
          </>
        ) : (
          <span className="text-[13px] italic text-neutral-text-secondary">{unassignLabel}</span>
        )}
      </span>
    );
  }

  return (
    <div ref={anchorRef} className="relative inline-flex items-center gap-2">
      {selected ? (
        <>
          <Avatar initials={selected.initials} />
          <span className="text-[13px] font-medium text-neutral-text-primary">
            {selected.primaryText}
          </span>
        </>
      ) : (
        <span className="text-[13px] italic text-neutral-text-secondary">{unassignLabel}</span>
      )}

      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="ml-1 rounded-control text-[12px] font-medium text-brand-primary hover:underline focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        {value ? triggerLabel.set : triggerLabel.unset}
      </button>

      {open &&
        popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            style={popoverStyle}
            // z-[70] (above the z-[60] modal tier): this combobox is embedded in
            // the z-[60] transfer dialogs, so the portaled panel must sit above the
            // modal scrim to stay clickable.
            className="z-[70] rounded-card border border-neutral-border bg-neutral-surface"
          >
            {/* Icon-prefixed search box — ring on the wrapper (rule 157). */}
            <div className="flex h-7 items-center gap-1.5 border-b border-neutral-border px-2 focus-within:ring-2 focus-within:ring-inset focus-within:ring-brand-primary">
              <svg
                aria-hidden="true"
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                className="shrink-0 text-neutral-text-secondary"
              >
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                <path
                  d="M11 11l3 3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              <input
                ref={inputRef}
                role="combobox"
                aria-controls={listboxId}
                aria-expanded={open}
                aria-autocomplete="list"
                aria-activedescendant={rows.length ? `${baseId}-opt-${activeIndex}` : undefined}
                aria-label={`Find a ${label}`}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={onKeyDown}
                placeholder={`Find a ${label}…`}
                className="w-full bg-transparent text-xs text-neutral-text-primary placeholder:text-neutral-text-secondary focus-visible:outline-none"
              />
            </div>

            <div
              role="listbox"
              aria-label={`Select ${label}`}
              id={listboxId}
              className="max-h-56 overflow-y-auto py-0.5"
            >
              {isLoading ? (
                <div role="status" className="px-2 py-1.5 text-xs text-neutral-text-secondary">
                  Loading…
                </div>
              ) : rows.length === 0 ? (
                <div role="status" className="px-2 py-1.5 text-xs text-neutral-text-secondary">
                  {query ? `No ${label}s match` : `No ${label}s available`}
                </div>
              ) : (
                <>
                  {rows.map((row, index) => {
                    const isSelected = row.id === value;
                    const isActive = index === activeIndex;
                    const isUnassign = row.id === null;
                    return (
                      <button
                        key={row.id ?? '__unassign__'}
                        type="button"
                        id={`${baseId}-opt-${index}`}
                        role="option"
                        tabIndex={-1}
                        aria-selected={isSelected}
                        aria-label={isUnassign ? `Unassign` : row.option!.primaryText}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => commit(index)}
                        className={[
                          'flex h-7 w-full items-center gap-1.5 px-2 text-left text-xs',
                          isUnassign ? 'border-b border-neutral-border/60' : '',
                          isActive ? 'bg-neutral-surface-sunken' : '',
                        ].join(' ')}
                      >
                        {isUnassign ? (
                          <>
                            <span
                              aria-hidden="true"
                              className="w-6 text-center text-neutral-text-secondary"
                            >
                              ⊘
                            </span>
                            <span className="flex-1 text-neutral-text-secondary">
                              {unassignLabel}
                            </span>
                          </>
                        ) : (
                          <>
                            <Avatar initials={row.option!.initials} />
                            <span className="flex-1 truncate text-neutral-text-primary">
                              {row.option!.primaryText}
                            </span>
                            {row.option!.secondaryText && (
                              <span className="hidden truncate text-neutral-text-secondary sm:block">
                                {row.option!.secondaryText}
                              </span>
                            )}
                          </>
                        )}
                        {isSelected && (
                          <svg
                            aria-hidden="true"
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            className="shrink-0 text-semantic-on-track"
                          >
                            <path
                              d="M3 8l3.5 3.5L13 5"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                  {/* When a query filters every member out but the pinned Unassign
                    row keeps the list non-empty, still tell the user nothing
                    matched (the ux-design spec for #966). */}
                  {query.trim() !== '' && rows.every((r) => r.id === null) && (
                    <div role="status" className="px-2 py-1.5 text-xs text-neutral-text-secondary">
                      No {label}s match
                    </div>
                  )}
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
