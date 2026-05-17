import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface RowMenuItem {
  /** Stable key for the item (also used as an accessible label fallback). */
  key: string;
  /** Visible label text. */
  label: string;
  /** Optional unicode glyph rendered to the left. */
  icon?: string;
  /** Optional hotkey hint rendered right-aligned (e.g. "F2", "Tab"). */
  hint?: string;
  /** When true, the item is rendered with destructive (red) styling. */
  destructive?: boolean;
  /** When true, the item is rendered disabled and cannot be activated. */
  disabled?: boolean;
  /** Inserts a separator above this item. */
  startsGroup?: boolean;
  onSelect: () => void;
}

export interface BuildModeRowMenuProps {
  /** Anchor coordinates in viewport space (clientX, clientY). */
  anchor: { x: number; y: number } | null;
  items: RowMenuItem[];
  onClose: () => void;
}

// 220px (bumped from 200 in ADR-0066) fits "Add predecessor…" + the ⌘D hint
// without truncation while still flipping cleanly inside a 1024-wide viewport.
const MENU_WIDTH = 220;
const ITEM_HEIGHT = 32;

/**
 * Schedule list row right-click menu.
 *
 * Anchored at the cursor; auto-flips to stay inside the viewport.
 * Closes on Escape, on click-outside, on selecting an item, and on scroll.
 * Keyboard navigation: Arrow keys cycle items, Enter activates, Esc closes.
 *
 * Built without Radix to avoid a dependency add for a single surface;
 * the primitive is small enough that re-implementation is cheaper than the
 * license + bundle review of @radix-ui/react-context-menu.
 */
export function BuildModeRowMenu({ anchor, items, onClose }: BuildModeRowMenuProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const menuRef = useRef<HTMLUListElement>(null);

  // Reset focus to first non-disabled item whenever the menu opens.
  useEffect(() => {
    if (!anchor) return;
    const firstEnabled = items.findIndex((it) => !it.disabled);
    setActiveIndex(firstEnabled === -1 ? 0 : firstEnabled);
  }, [anchor, items]);

  // Listen for Escape, click-outside, and scroll to dismiss.
  useEffect(() => {
    if (!anchor) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((idx) => {
          const direction = e.key === 'ArrowDown' ? 1 : -1;
          let next = idx;
          for (let step = 0; step < items.length; step++) {
            next = (next + direction + items.length) % items.length;
            if (!items[next].disabled) return next;
          }
          return idx;
        });
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = items[activeIndex];
        if (item && !item.disabled) {
          item.onSelect();
          onClose();
        }
      }
    };

    const handlePointer = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) onClose();
    };

    const handleScroll = () => onClose();

    window.addEventListener('keydown', handleKey);
    window.addEventListener('mousedown', handlePointer);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('mousedown', handlePointer);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [anchor, activeIndex, items, onClose]);

  if (!anchor) return null;

  // Auto-flip if the menu would overflow the viewport.
  const menuHeight = items.length * ITEM_HEIGHT + 8;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const top =
    anchor.y + menuHeight > viewportH ? Math.max(0, anchor.y - menuHeight) : anchor.y;
  const left =
    anchor.x + MENU_WIDTH > viewportW ? Math.max(0, anchor.x - MENU_WIDTH) : anchor.x;

  return createPortal(
    <ul
      ref={menuRef}
      role="menu"
      aria-label="Row actions"
      className="fixed z-50 bg-neutral-surface border border-neutral-border rounded-md py-1 text-[13px]"
      style={{ top, left, width: MENU_WIDTH }}
    >
      {items.map((item, idx) => (
        <li key={item.key}>
          {item.startsGroup && idx > 0 && (
            <div className="my-1 border-t border-neutral-border/40" aria-hidden="true" />
          )}
          <button
            type="button"
            role="menuitem"
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            onMouseEnter={() => !item.disabled && setActiveIndex(idx)}
            onClick={(e) => {
              // Stop propagation: portal clicks bubble through the React tree,
              // and the row's onClick would otherwise run after item.onSelect
              // and overwrite any focus-state transition the action just made.
              e.stopPropagation();
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
            className={[
              'group flex w-full items-center gap-2 px-3 h-8 text-left',
              item.disabled
                ? 'text-neutral-text-disabled cursor-not-allowed'
                : item.destructive
                  ? 'text-semantic-critical hover:bg-semantic-critical/10'
                  : 'text-neutral-text-primary hover:bg-neutral-row-hover',
              !item.disabled && idx === activeIndex
                ? item.destructive
                  ? 'bg-semantic-critical/10'
                  : 'bg-neutral-row-hover'
                : '',
            ].join(' ')}
          >
            {item.icon && (
              <span className="w-4 text-center text-neutral-text-secondary" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span className="flex-1 truncate">{item.label}</span>
            {item.hint && (
              <span className="tppm-mono text-[11px] text-neutral-text-secondary">
                {item.hint}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>,
    document.body,
  );
}
