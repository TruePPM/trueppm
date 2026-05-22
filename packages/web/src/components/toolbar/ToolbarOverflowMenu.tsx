/**
 * Shared overflow popover for toolbar secondary controls (issue #568).
 *
 * Renders a `⋯` trigger that opens a `role="menu"` popover. Each child item
 * is either a `role="menuitem"` action or a `role="menuitemcheckbox"` toggle.
 * Used by Schedule, Board, and Resource toolbars below `md:` to collapse
 * secondary controls — see rules 110–112 in `packages/web/CLAUDE.md`.
 *
 * Keyboard contract (rule 112):
 *  - `ArrowDown` / `ArrowUp` move focus through items (wraps at the ends)
 *  - `Home` / `End` jump to first / last item
 *  - `Enter` or `Space` activates the focused item; checkbox items toggle in place
 *  - `Escape` closes the menu and returns focus to the trigger
 *  - Click outside closes the menu without activation
 *
 * Per rule 112 the trigger should be rendered with `md:hidden` by callers —
 * the menu must not appear at `lg:` viewports.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

export type ToolbarOverflowItem =
  | {
      kind: 'action';
      id: string;
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      /** Optional leading glyph rendered as decorative text. */
      icon?: ReactNode;
    }
  | {
      kind: 'checkbox';
      id: string;
      label: string;
      checked: boolean;
      onChange: (next: boolean) => void;
      disabled?: boolean;
      icon?: ReactNode;
    };

export interface ToolbarOverflowMenuProps {
  /** Items to render inside the popover, in display order. */
  items: ToolbarOverflowItem[];
  /** Accessible label for the trigger button (defaults to "More options"). */
  triggerAriaLabel?: string;
  /** Extra classes for the wrapping `<div>`. Use to control responsive
   *  visibility (callers typically pass `md:hidden`). */
  className?: string;
  /** Anchor edge for the popover. `right` keeps the menu inside the viewport
   *  when the trigger sits at the right edge of the toolbar. */
  align?: 'left' | 'right';
}

export function ToolbarOverflowMenu({
  items,
  triggerAriaLabel = 'More options',
  className,
  align = 'right',
}: ToolbarOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Click outside the menu closes it. Pointerdown on the trigger is excluded
  // so the toggle flow does not double-fire (open then immediately close).
  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  // Move DOM focus to the active item whenever the menu opens or the active
  // index changes. Layout effect avoids a paint flash where the previous item
  // briefly holds focus.
  useLayoutEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setActiveIndex(0);
      setOpen(true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(Math.max(0, items.length - 1));
      setOpen(true);
    }
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(items.length - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      // Tab leaves the menu — close without restoring focus to the trigger so
      // the user lands wherever the natural tab order took them.
      setOpen(false);
    }
  }

  function activate(item: ToolbarOverflowItem) {
    if (item.disabled) return;
    if (item.kind === 'action') {
      item.onSelect();
      setOpen(false);
      triggerRef.current?.focus();
    } else {
      item.onChange(!item.checked);
      // Checkbox items stay open so the user can toggle multiple in a row.
    }
  }

  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={triggerAriaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setActiveIndex(0);
          setOpen((v) => !v);
        }}
        onKeyDown={onTriggerKeyDown}
        className="
          inline-flex items-center justify-center
          h-7 w-7 rounded border border-neutral-border
          text-neutral-text-secondary hover:text-neutral-text-primary
          hover:bg-neutral-surface-raised
          focus-visible:outline-none focus-visible:ring-2
          focus-visible:ring-brand-primary focus-visible:ring-offset-1
        "
      >
        <span aria-hidden="true" className="text-[16px] leading-none">⋯</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={triggerAriaLabel}
          // Focus lives on the active `<button>` child; the outer container is
          // a roving container, not the tab stop itself. `tabIndex={-1}` makes
          // it programmatically focusable so jsx-a11y is satisfied without
          // intercepting Tab.
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          className={[
            'absolute z-30 top-full mt-1 min-w-[200px]',
            'rounded border border-neutral-border bg-neutral-surface',
            'py-1',
            align === 'right' ? 'right-0' : 'left-0',
          ].join(' ')}
        >
          {items.map((item, index) => {
            const baseCls = [
              'flex items-center w-full px-3 py-1.5 gap-2 text-left text-xs',
              'text-neutral-text-primary hover:bg-neutral-surface-raised',
              'focus-visible:outline-none focus-visible:bg-neutral-surface-raised',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            ].join(' ');
            if (item.kind === 'action') {
              return (
                <button
                  key={item.id}
                  ref={(el) => { itemRefs.current[index] = el; }}
                  type="button"
                  role="menuitem"
                  tabIndex={index === activeIndex ? 0 : -1}
                  disabled={item.disabled}
                  onClick={() => activate(item)}
                  className={baseCls}
                >
                  {item.icon && <span aria-hidden="true" className="text-neutral-text-secondary">{item.icon}</span>}
                  <span className="flex-1">{item.label}</span>
                </button>
              );
            }
            return (
              <button
                key={item.id}
                ref={(el) => { itemRefs.current[index] = el; }}
                type="button"
                role="menuitemcheckbox"
                aria-checked={item.checked}
                tabIndex={index === activeIndex ? 0 : -1}
                disabled={item.disabled}
                onClick={() => activate(item)}
                className={baseCls}
              >
                {item.icon && <span aria-hidden="true" className="text-neutral-text-secondary">{item.icon}</span>}
                <span className="flex-1">{item.label}</span>
                <span aria-hidden="true" className="text-brand-primary w-3 text-right">
                  {item.checked ? '✓' : ''}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
