import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useFiscalYearStartMonth } from '@/hooks/useFiscalYearStartMonth';

/**
 * Contextual quarter-tier toggle next to the ZoomControl (#755).
 *
 * Lets the user view the Schedule timeline's quarter/year header in **fiscal**
 * mode (follows the workspace `fiscal_year_start`) or plain **calendar** mode.
 * The choice is a per-user view preference persisted in localStorage via the
 * schedule store — not project data.
 *
 * Visibility rules (from the issue's UX spec):
 *  - Only meaningful at quarter/year zoom — hidden at day/week/month.
 *  - Hidden entirely when the workspace fiscal year starts in January, because
 *    fiscal and calendar quarters are then identical (no decision to make).
 */

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function QuarterModeControl() {
  const zoomLevel = useScheduleStore((s) => s.zoomLevel);
  const quarterMode = useScheduleStore((s) => s.quarterMode);
  const setQuarterMode = useScheduleStore((s) => s.setQuarterMode);
  const startMonth = useFiscalYearStartMonth();

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

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

  // Only relevant at quarter/year zoom, and only when fiscal ≠ calendar.
  if ((zoomLevel !== 'quarter' && zoomLevel !== 'year') || startMonth === 1) {
    return null;
  }

  function choose(mode: 'fiscal' | 'calendar') {
    setQuarterMode(mode);
    close();
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  const label = quarterMode === 'fiscal' ? 'Quarters: Fiscal' : 'Quarters: Calendar';

  return (
    <div className="relative flex-shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="border border-neutral-border rounded h-7 px-3 text-xs font-medium
          inline-flex items-center gap-1
          focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none
          hover:border-brand-primary hover:text-brand-primary"
      >
        {label}
        <span aria-hidden="true" className="text-[10px] leading-none">
          ▾
        </span>
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Quarter labels"
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-8 z-30 min-w-[240px] rounded border border-neutral-border
            bg-neutral-surface py-1"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={quarterMode === 'fiscal'}
            onClick={() => choose('fiscal')}
            className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs
              text-neutral-text-primary hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:bg-neutral-surface-raised"
          >
            <span aria-hidden="true" className="w-3 text-brand-primary">
              {quarterMode === 'fiscal' ? '●' : '○'}
            </span>
            <span className="flex flex-col">
              <span className="font-medium">Fiscal</span>
              <span className="text-neutral-text-secondary">
                starts {MONTH_NAMES[startMonth - 1]} (workspace)
              </span>
            </span>
          </button>

          <button
            type="button"
            role="menuitemradio"
            aria-checked={quarterMode === 'calendar'}
            onClick={() => choose('calendar')}
            className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs
              text-neutral-text-primary hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:bg-neutral-surface-raised"
          >
            <span aria-hidden="true" className="w-3 text-brand-primary">
              {quarterMode === 'calendar' ? '●' : '○'}
            </span>
            <span className="flex flex-col">
              <span className="font-medium">Calendar</span>
              <span className="text-neutral-text-secondary">Jan–Mar = Q1</span>
            </span>
          </button>

          <div className="my-1 border-t border-neutral-border" role="separator" />

          <Link
            to="/settings/general"
            role="menuitem"
            className="flex items-center gap-1 px-3 py-1.5 text-xs text-neutral-text-secondary
              hover:bg-neutral-surface-raised hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:bg-neutral-surface-raised"
            onClick={() => setOpen(false)}
          >
            Set fiscal year in Workspace settings
            <span aria-hidden="true">↗</span>
          </Link>
        </div>
      )}
    </div>
  );
}
