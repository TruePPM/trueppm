import { useState, useRef, useEffect, type ReactNode, type KeyboardEvent } from 'react';

export interface BadgePopoverItem {
  id: string;
  wbs: string;
  name: string;
}

interface Props {
  /** Accessible label for the trigger button, e.g. "2 at risk tasks" */
  label: string;
  count: number;
  items: BadgePopoverItem[];
  colorVariant: 'at-risk' | 'critical';
  icon: ReactNode;
  onItemClick: (id: string) => void;
}

const MAX_VISIBLE = 5;

/**
 * Badge button that opens a menu popover listing affected tasks.
 * Clicking a task item calls onItemClick and dismisses the popover.
 *
 * Desktop: absolute-positioned popover below the badge.
 * Mobile bottom sheet is deferred to when mobile breakpoints ship.
 *
 * Uses role="menu" / aria-haspopup="menu" — NOT listbox — because items
 * trigger navigation actions, not value selection. (rule 39 / WCAG 4.1.2)
 */
export function BadgePopover({ label, count, items, colorVariant, icon, onItemClick }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // /80 border yields ~4.25:1+ against white, passing WCAG 3:1 (rule 39, #205).
  // bg-semantic-*-bg provides the spec tint fill; text uses the full semantic token.
  const colorClasses =
    colorVariant === 'at-risk'
      ? 'border-semantic-at-risk/80 bg-semantic-at-risk-bg text-semantic-at-risk'
      : 'border-semantic-critical/80 bg-semantic-critical-bg text-semantic-critical';

  // Outside-click dismiss
  useEffect(() => {
    if (!isOpen) return;
    function handleMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isOpen]);

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      setIsOpen(false);
      triggerRef.current?.focus();
    }
  }

  function handleItemClick(id: string) {
    setIsOpen(false);
    onItemClick(id);
  }

  const visibleItems = items.slice(0, MAX_VISIBLE);
  const overflowCount = items.length - MAX_VISIBLE;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={label}
        onClick={() => setIsOpen((o) => !o)}
        onKeyDown={handleKeyDown}
        className={`flex items-center gap-1 h-6 px-2 rounded-control border text-[12px] font-medium
          min-h-[44px] min-w-[44px] justify-center
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
          ${colorClasses}`}
      >
        {icon}
        {count}
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          className="absolute top-full right-0 mt-1 z-50 min-w-[200px] bg-neutral-surface border border-neutral-border rounded-card p-1"
        >
          {visibleItems.map((item) => (
            <button
              key={item.id}
              role="menuitem"
              type="button"
              onClick={() => handleItemClick(item.id)}
              className="w-full text-left px-2 py-1 rounded-control text-xs text-neutral-text-primary
                hover:bg-neutral-surface-raised
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              <span className="text-neutral-text-secondary mr-1">{item.wbs}</span>
              <span className="truncate">{item.name}</span>
            </button>
          ))}
          {overflowCount > 0 && (
            <div
              role="presentation"
              className="px-2 py-1 text-xs text-neutral-text-secondary"
            >
              {overflowCount} more — see full list
            </div>
          )}
        </div>
      )}
    </div>
  );
}
