/**
 * DayOverflowButton — the "+N more" control in a month-mode day cell (web rule 296).
 *
 * A month week row caps at four chip lanes, so the chips beyond the cap are not
 * rendered at all. A truncation notice has to ship with a way past the cap on the
 * same surface, so this opens a popover listing every hidden chip that starts on
 * the day; choosing one opens the task like any chip does.
 *
 * Mechanics: portaled to `document.body` and positioned by `useAnchoredPopover`
 * (rule 260), because the grid scrolls inside an `overflow-y-auto` ancestor that
 * would clip it. The panel carries a height guard and `overflow-y-auto` (rule 351).
 * Escape peels exactly this layer and returns focus to the trigger.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import type { CalendarChipData } from './calendarUtils';

interface DayOverflowButtonProps {
  /** Chips hidden by the lane cap that start on this day. */
  hidden: CalendarChipData[];
  /** Human-readable day, used in the accessible names. */
  dayLabel: string;
  onTaskClick: (taskId: string) => void;
  /** Extra classes for the trigger (the non-working-day backing). */
  className?: string;
}

const PANEL_WIDTH = 240;
const ITEM_HEIGHT = 32;

export function DayOverflowButton({
  hidden,
  dayLabel,
  onTaskClick,
  className = '',
}: DayOverflowButtonProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const { triggerRef, popoverRef, popoverStyle } = useAnchoredPopover<
    HTMLButtonElement,
    HTMLDivElement
  >({
    open,
    width: PANEL_WIDTH,
    estimatedHeight: Math.min(hidden.length, 8) * ITEM_HEIGHT + 16,
    onDismiss: () => setOpen(false),
  });

  // Move focus into the panel once it has been positioned and mounted.
  useEffect(() => {
    if (open && popoverStyle) firstItemRef.current?.focus();
  }, [open, popoverStyle !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape peels exactly this layer. Capture phase so an outer Escape handler
  // (the drawer, a modal) does not also fire for the same keypress.
  useEffect(() => {
    if (!open) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, triggerRef]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${hidden.length} more ${hidden.length === 1 ? 'task' : 'tasks'} on ${dayLabel}`}
        onClick={() => setOpen((v) => !v)}
        className={`absolute bottom-1 left-1 rounded text-xs text-neutral-text-secondary underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 ${className}`}
      >
        +{hidden.length} more
      </button>
      {open &&
        popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            id={panelId}
            role="dialog"
            aria-label={`Tasks on ${dayLabel}`}
            style={popoverStyle}
            className="z-50 overflow-y-auto rounded-control border border-neutral-border bg-neutral-surface p-1"
          >
            {hidden.map((chip, i) => (
              <button
                key={`${chip.taskId}:${chip.weekStart}`}
                ref={i === 0 ? firstItemRef : undefined}
                type="button"
                onClick={() => {
                  close(false);
                  onTaskClick(chip.taskId);
                }}
                className="block min-h-8 w-full truncate rounded px-2 text-left text-sm text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                {chip.taskName}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
