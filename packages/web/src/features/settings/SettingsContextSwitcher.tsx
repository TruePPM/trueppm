import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

export type ContextHealth = 'onTrack' | 'atRisk' | 'critical';

export interface SettingsContextOption {
  /** Entity id (program / project). */
  id: string;
  /** Display name. */
  name: string;
  /** Health dot color; null/undefined → neutral (e.g. AUTO / unknown). */
  health?: ContextHealth | null;
  /** Full route to this entity's settings, current sub-page preserved. */
  to: string;
}

const HEALTH_COLOR: Record<ContextHealth, string> = {
  onTrack: 'bg-semantic-on-track',
  atRisk: 'bg-semantic-at-risk',
  critical: 'bg-semantic-critical',
};

// Plain-English health for accessible names — the dot is color-only, so health
// must also reach screen readers / color-blind users (design rule 6).
const HEALTH_LABEL: Record<ContextHealth, string> = {
  onTrack: 'on track',
  atRisk: 'at risk',
  critical: 'critical',
};

/** "{name}, {health}" for option/trigger accessible names; name alone when neutral. */
function withHealth(name: string, health?: ContextHealth | null): string {
  return health ? `${name}, ${HEALTH_LABEL[health]}` : name;
}

function HealthDot({ health }: { health?: ContextHealth | null }) {
  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${health ? HEALTH_COLOR[health] : 'bg-neutral-text-disabled'}`}
      aria-hidden="true"
    />
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" className="shrink-0 text-semantic-on-track" aria-hidden="true">
      <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

interface Props {
  /** Current entity name shown on the trigger. */
  contextName: string;
  /** Current entity health (drives the trigger dot). */
  contextHealth?: ContextHealth | null;
  /** Sibling entities to switch between — caller guarantees length >= 2. */
  options: SettingsContextOption[];
  /** The current entity's id (gets the checkmark). */
  activeId?: string;
  /** Lowercase noun for ARIA labels + placeholder, e.g. "program" / "project". */
  entityLabel: string;
  /** Routes through SettingsShell's dirty-form guard before navigating. */
  onSelect: (to: string) => void;
}

/**
 * Context-entity switcher for the settings shell pill (#776).
 *
 * The entity-identity row (health dot + name + chevron) is a trigger; opening
 * reveals a `combobox` search input + `role="listbox"` of sibling entities.
 * Type to filter by name; focus stays in the input with the highlight tracked
 * via `aria-activedescendant`. Choosing a different entity calls `onSelect(to)`,
 * which the shell routes through its dirty-form guard. Mounted only when there
 * are >= 2 options. The search box is always present (no scan-then-search gap).
 */
export function SettingsContextSwitcher({
  contextName,
  contextHealth,
  options,
  activeId,
  entityLabel,
  onSelect,
}: Props) {
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

  // Click-outside dismiss (does not return focus — the user clicked elsewhere).
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

  // On open: focus the search input and seed the highlight to the active entity
  // (else the first option).
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const activeIdx = options.findIndex((o) => o.id === activeId);
    setActiveIndex(activeIdx >= 0 ? activeIdx : 0);
  }, [open, options, activeId]);

  // Keep the highlight in range as the filtered set shrinks, and scroll the
  // highlighted option into view during keyboard navigation.
  useEffect(() => {
    if (!open) return;
    if (activeIndex > filtered.length - 1) {
      setActiveIndex(filtered.length > 0 ? filtered.length - 1 : 0);
    } else {
      // Optional-call: scrollIntoView is unimplemented in jsdom (tests).
      optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [open, activeIndex, filtered.length]);

  const handleSelect = (opt: SettingsContextOption) => {
    // Choosing the current entity is a no-op beyond closing the menu.
    if (opt.id !== activeId) onSelect(opt.to);
    close(true);
  };

  const handleInputKeyDown = (e: KeyboardEvent) => {
    const n = filtered.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (n) setActiveIndex((i) => (i + 1) % n); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) setActiveIndex((i) => (i - 1 + n) % n); }
    else if (e.key === 'Home') { e.preventDefault(); setActiveIndex(0); }
    else if (e.key === 'End') { e.preventDefault(); setActiveIndex(Math.max(0, n - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[activeIndex];
      if (opt) handleSelect(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Two-stage: clear a query first; only close when already empty.
      if (query) { setQuery(''); setActiveIndex(0); }
      else close(true);
    }
  };

  return (
    <div className="relative flex-1 min-w-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Current ${entityLabel}: ${withHealth(contextName, contextHealth)}. Switch ${entityLabel}.`}
        className="w-full min-w-0 flex items-center gap-1.5 rounded text-left
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <HealthDot health={contextHealth} />
        <span className="flex-1 truncate text-neutral-text-primary font-medium">{contextName}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          className={`shrink-0 text-neutral-text-disabled transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute left-0 right-0 top-full mt-1 z-20 rounded border border-neutral-border bg-neutral-surface"
        >
          {/* Search box — always present, pinned above the scrolling list.
              focus-within (not focus-visible) so the programmatic open-focus
              shows a ring too. */}
          <div className="flex items-center gap-1.5 px-2 h-7 border-b border-neutral-border
            focus-within:ring-2 focus-within:ring-inset focus-within:ring-brand-primary">
            <svg width="12" height="12" viewBox="0 0 16 16" className="shrink-0 text-neutral-text-disabled" aria-hidden="true">
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
              aria-label={`Find a ${entityLabel}`}
              placeholder={`Find a ${entityLabel}…`}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleInputKeyDown}
              className="flex-1 min-w-0 bg-transparent text-[11px] text-neutral-text-primary placeholder:text-neutral-text-disabled focus:outline-none"
            />
          </div>

          <div id={listboxId} role="listbox" aria-label={`Switch ${entityLabel}`} className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div role="status" aria-live="polite" className="flex items-center px-2 h-7 text-[11px] text-neutral-text-secondary">
                No {entityLabel}s match
              </div>
            ) : (
              filtered.map((opt, i) => {
                const isActive = opt.id === activeId;
                const isHighlighted = i === activeIndex;
                return (
                  <button
                    key={opt.id}
                    id={optionId(i)}
                    ref={(el) => {
                      optionRefs.current[i] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    aria-label={withHealth(opt.name, opt.health)}
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => handleSelect(opt)}
                    className={`w-full flex items-center gap-1.5 px-2 h-7 text-[11px] text-left text-neutral-text-primary ${isHighlighted ? 'bg-neutral-surface-sunken' : ''}`}
                  >
                    <HealthDot health={opt.health} />
                    <span className="flex-1 truncate">{opt.name}</span>
                    {isActive && <CheckIcon />}
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
