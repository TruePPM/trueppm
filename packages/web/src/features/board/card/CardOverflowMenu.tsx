import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import type { Task, TaskStatus } from '@/types';
import type { BoardCardColumn, BoardCardScopeActions } from './types';

interface CardOverflowMenuProps {
  task: Task;
  /** Columns other than the card's own — the "Move to…" submenu targets. */
  otherColumns: BoardCardColumn[];
  onMenuMove: (task: Task, newStatus: TaskStatus) => void;
  /** True when the card is a not-yet-accepted scope injection (ADR-0102). */
  isPending: boolean;
  scopeActions?: BoardCardScopeActions;
  /** Iteration vocabulary for the reject label ("Reject from sprint"). */
  iterationLabel: string;
}

/**
 * The card's ··· overflow menu: reject-scope-injection (ADR-0102), and the
 * "Move to…" submenu. Owns its own open/submenu state, roving focus, and
 * outside-click dismissal so `BoardCard` stays a layout shell.
 *
 * The outer panel is positioned via the shared `useAnchoredPopover` hook
 * (rule 260): portaled to `document.body`, `position: fixed`, flipped/clamped
 * against the viewport. The old in-flow `absolute right-0` could not escape
 * the board column's `overflow-y-auto` ancestor (rule 253(d)'s exact
 * scenario) and never accounted for the viewport, so a card near the top or
 * either edge of a column clipped this menu's content (#3705). The nested
 * "Move to…" submenu stays in-flow inside the portaled panel — it is not a
 * second floating surface.
 */
export function CardOverflowMenu({
  task,
  otherColumns,
  onMenuMove,
  isPending,
  scopeActions,
  iterationLabel,
}: CardOverflowMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  // issue 838: roving-focus keyboard nav for the overflow menu + submenu.
  const menuPanelRef = useRef<HTMLDivElement>(null);

  // Reject is gated the same way the accept ✓ is: role-gated and hidden offline
  // (rule 152 — never queue a stale scope decision).
  const canReject = isPending && scopeActions?.canManage === true && !scopeActions.offline;

  // Rough content-height estimate for the hook's initial flip decision only —
  // sized to the fully-expanded submenu, since `moveOpen` can toggle after
  // open without a fresh flip decision (the reposition effect below handles
  // the position once the submenu actually expands).
  const estimatedHeight = Math.min(420, 48 + (canReject ? 36 : 0) + 36 + otherColumns.length * 36);
  const {
    triggerRef: menuTriggerRef,
    popoverRef,
    popoverStyle,
    reposition,
  } = useAnchoredPopover<HTMLButtonElement, HTMLDivElement>({
    open: menuOpen,
    width: 200,
    estimatedHeight,
    align: 'right',
    onDismiss: () => {
      setMenuOpen(false);
      setMoveOpen(false);
    },
  });

  // Focus the first menuitem when the menu opens so keyboard users land inside it.
  // Depends only on menuOpen — opening the Move-to submenu must not steal focus
  // back to the first item.
  useEffect(() => {
    if (!menuOpen) return;
    const first = menuPanelRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [menuOpen]);

  // The submenu can grow the panel's real content height after `menuOpen`
  // already decided whether to flip above/below — recompute once it does.
  useEffect(() => {
    if (menuOpen) reposition();
  }, [moveOpen, menuOpen, reposition]);

  // Arrow/Home/End/Escape navigation across the menu's visible menuitems
  // (including submenu items once Move-to is expanded). Escape closes and
  // restores focus to the ··· trigger (WCAG 2.1.1 menu pattern, issue 838).
  const onMenuKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setMenuOpen(false);
      setMoveOpen(false);
      menuTriggerRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(
      menuPanelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else next = current <= 0 ? items.length - 1 : current - 1;
    items[next]?.focus();
  }, [menuTriggerRef]);

  return (
    <div className="absolute top-2 right-2">
      <button
        ref={menuTriggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen(!menuOpen);
          setMoveOpen(false);
        }}
        className="relative before:absolute before:inset-[-10px] before:content-[''] w-6 h-6 flex items-center justify-center rounded-control text-neutral-text-secondary
          hover:bg-neutral-surface-raised opacity-0 group-hover:opacity-100 max-md:opacity-100
          focus:opacity-100 focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-1"
        aria-label={`Actions for ${task.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        ···
      </button>

      {menuOpen &&
        popoverStyle &&
        createPortal(
          <div
            ref={(node) => {
              // Both the hook's own ref (positioning) and the roving-focus ref
              // (item lookups) target the same portaled node.
              popoverRef.current = node;
              menuPanelRef.current = node;
            }}
            style={popoverStyle}
            role="menu"
            tabIndex={-1}
            aria-label={`Actions for ${task.name}`}
            onKeyDown={onMenuKeyDown}
            className="z-20 overflow-y-auto bg-neutral-surface border border-neutral-border rounded-card py-1
            focus:outline-none"
          >
            {/* Reject scope injection (ADR-0102) — critical text, gated. The
              additive accept is the single-tap ✓; reject (destructive) lives
              here. Hidden offline (rule 152: never queue a stale decision). */}
            {canReject && (
              <button
                type="button"
                role="menuitem"
                className="w-full text-left px-3 py-2 text-sm text-semantic-critical
                hover:bg-semantic-critical-bg
                focus:ring-2 focus:ring-semantic-critical focus:ring-inset"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  setMoveOpen(false);
                  scopeActions?.onReject(task);
                }}
              >
                Reject from {iterationLabel}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="w-full text-left px-3 py-2 text-sm text-neutral-text-primary
              hover:bg-neutral-surface-raised
              focus:ring-2 focus:ring-brand-primary focus:ring-inset"
              onClick={(e) => {
                e.stopPropagation();
                setMoveOpen(!moveOpen);
              }}
              aria-haspopup="menu"
              aria-expanded={moveOpen}
            >
              Move to…
            </button>

            {moveOpen && (
              <div
                role="menu" // dropdown-scroll-ok: nested 'Move to...' submenu renders in-flow inside the outer panel's own guard, not a second scrollable surface
                className="border-t border-neutral-border"
              >
                {otherColumns.map((col) => (
                  <button
                    key={col.status}
                    type="button"
                    role="menuitem"
                    className="w-full text-left px-5 py-2 text-sm text-neutral-text-primary
                    hover:bg-neutral-surface-raised
                    focus:ring-2 focus:ring-brand-primary focus:ring-inset"
                    onClick={(e) => {
                      e.stopPropagation();
                      onMenuMove(task, col.status);
                      setMenuOpen(false);
                      setMoveOpen(false);
                    }}
                  >
                    {col.label}
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
