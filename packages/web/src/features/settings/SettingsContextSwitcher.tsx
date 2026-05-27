import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

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

interface Props {
  /** Current entity name shown on the trigger. */
  contextName: string;
  /** Current entity health (drives the trigger dot). */
  contextHealth?: ContextHealth | null;
  /** Sibling entities to switch between — caller guarantees length >= 2. */
  options: SettingsContextOption[];
  /** The current entity's id (gets the checkmark). */
  activeId?: string;
  /** Lowercase noun for ARIA labels, e.g. "program" / "project". */
  entityLabel: string;
  /** Routes through SettingsShell's dirty-form guard before navigating. */
  onSelect: (to: string) => void;
}

/**
 * Context-entity switcher for the settings shell pill (#776).
 *
 * Renders the entity-identity row (health dot + name + chevron) as a menu
 * trigger. Opening lists the sibling entities in the current scope; choosing a
 * different one calls `onSelect(to)` — which the shell routes through its
 * dirty-form guard. Mounted only when there are >= 2 options, so the chevron
 * never advertises a switch that can't happen.
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Click-outside dismiss (does not return focus — the user clicked elsewhere).
  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [open]);

  // On open, focus the active row (else the first).
  useEffect(() => {
    if (!open) return;
    const activeIndex = options.findIndex((o) => o.id === activeId);
    const idx = activeIndex >= 0 ? activeIndex : 0;
    itemRefs.current[idx]?.focus();
  }, [open, options, activeId]);

  const focusItem = (idx: number) => {
    const n = options.length;
    const wrapped = ((idx % n) + n) % n;
    itemRefs.current[wrapped]?.focus();
  };

  const handleMenuKeyDown = (e: KeyboardEvent) => {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(current + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusItem(current - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusItem(options.length - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    }
  };

  const handleSelect = (opt: SettingsContextOption) => {
    // Choosing the current entity is a no-op beyond closing the menu.
    if (opt.id !== activeId) onSelect(opt.to);
    close(true);
  };

  return (
    <div className="relative flex-1 min-w-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
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
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          aria-label={`Switch ${entityLabel}`}
          onKeyDown={handleMenuKeyDown}
          className="absolute left-0 right-0 top-full mt-1 z-20 max-h-64 overflow-y-auto
            rounded border border-neutral-border bg-neutral-surface py-1"
        >
          {options.map((opt, i) => {
            const isActive = opt.id === activeId;
            return (
              <button
                key={opt.id}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                aria-label={withHealth(opt.name, opt.health)}
                tabIndex={-1}
                onClick={() => handleSelect(opt)}
                className="w-full flex items-center gap-1.5 px-2 h-7 text-[11px] text-left
                  text-neutral-text-primary hover:bg-neutral-surface-sunken
                  focus-visible:outline-none focus-visible:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary"
              >
                <HealthDot health={opt.health} />
                <span className="flex-1 truncate">{opt.name}</span>
                {isActive && (
                  <svg width="12" height="12" viewBox="0 0 16 16" className="shrink-0 text-semantic-on-track" aria-hidden="true">
                    <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
