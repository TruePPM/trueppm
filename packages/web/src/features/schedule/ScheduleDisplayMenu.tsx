/**
 * Schedule "Display" menu — the Show cluster of the Schedule toolbar (#1741).
 *
 * Houses the four view/render filters (CP only, Focus chain, Critical path,
 * Milestones) and the optional column-visibility toggles behind a single
 * `Display ▾` trigger, so the toolbar stays at ≤6 top-level affordances
 * (rules 110–114, ADR-0064). This is the *permanent home* for the filters at
 * every width — they never migrate into the `···` overflow (web rule 243).
 *
 * The filters are `menuitemcheckbox` rows (multi-toggle, menu stays open); the
 * trigger carries an active-filter count badge so "you are looking at a filtered
 * subset" stays glanceable while the controls are folded away. The badge counts
 * only the four *data* filters — hiding a table column is a layout preference,
 * not a data filter, so it never lights the badge.
 *
 * Keyboard contract mirrors {@link ToolbarOverflowMenu} (rule 112): ArrowUp/Down
 * rove the focusable rows (section headings are skipped), Home/End jump, Enter/
 * Space toggle in place, Escape closes and restores focus to the trigger, Tab
 * closes and falls through, outside pointerdown closes. Non-modal — no focus trap.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { ChevronDownIcon, SlidersIcon } from '@/components/Icons';

/** A single toggle row inside the Display menu. */
export interface DisplayMenuRow {
  id: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

/** A labeled group of rows (rendered with a heading + separator). */
export interface DisplayMenuSection {
  id: string;
  label: string;
  rows: DisplayMenuRow[];
}

export interface ScheduleDisplayMenuProps {
  showCpOnly: boolean;
  setShowCpOnly: (v: boolean) => void;
  focusModeEnabled: boolean;
  setFocusModeEnabled: (v: boolean) => void;
  showCriticalOnly: boolean;
  setShowCriticalOnly: (v: boolean) => void;
  showMilestonesOnly: boolean;
  setShowMilestonesOnly: (v: boolean) => void;
  /** Column-visibility rows, or null when the columns surface is not applicable
   *  (Timeline mode, or mobile where the task-list panel is not rendered). */
  columns: DisplayMenuRow[] | null;
  /** Collapse the trigger to icon-only (md/sm) — the "Display" label is dropped
   *  but the accessible name (with any active-filter count) is retained. */
  iconOnly: boolean;
}

export function ScheduleDisplayMenu({
  showCpOnly,
  setShowCpOnly,
  focusModeEnabled,
  setFocusModeEnabled,
  showCriticalOnly,
  setShowCriticalOnly,
  showMilestonesOnly,
  setShowMilestonesOnly,
  columns,
  iconOnly,
}: ScheduleDisplayMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const sections: DisplayMenuSection[] = [
    {
      id: 'view-filters',
      label: 'View filters',
      rows: [
        { id: 'cp-only', label: 'CP only', checked: showCpOnly, onChange: setShowCpOnly },
        {
          id: 'focus-chain',
          label: 'Focus chain',
          checked: focusModeEnabled,
          onChange: setFocusModeEnabled,
        },
      ],
    },
    {
      id: 'render-filters',
      label: 'Render filters',
      rows: [
        {
          id: 'critical-path',
          label: 'Critical path',
          checked: showCriticalOnly,
          onChange: setShowCriticalOnly,
        },
        {
          id: 'milestones',
          label: 'Milestones',
          checked: showMilestonesOnly,
          onChange: setShowMilestonesOnly,
        },
      ],
    },
    ...(columns && columns.length > 0
      ? [{ id: 'columns', label: 'Columns', rows: columns }]
      : []),
  ];

  // Flatten to a single roving list — section headings are not focusable.
  const rows = sections.flatMap((s) => s.rows);

  // Active-filter badge counts only the four data filters (not column visibility).
  const activeFilterCount = [
    showCpOnly,
    focusModeEnabled,
    showCriticalOnly,
    showMilestonesOnly,
  ].filter(Boolean).length;

  const triggerLabel =
    activeFilterCount > 0
      ? `Display, ${activeFilterCount} active ${activeFilterCount === 1 ? 'filter' : 'filters'}`
      : 'Display';

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
      setActiveIndex(Math.max(0, rows.length - 1));
      setOpen(true);
    }
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (rows.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % rows.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(rows.length - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  // Track the running flat index so each row can map to its roving position.
  let flatIndex = -1;

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={iconOnly ? triggerLabel : undefined}
        onClick={() => {
          setActiveIndex(0);
          setOpen((v) => !v);
        }}
        onKeyDown={onTriggerKeyDown}
        className="relative inline-flex items-center gap-1.5 h-7 rounded-control border border-neutral-border
          px-2 lg:px-3 text-xs font-medium text-neutral-text-primary
          hover:border-brand-primary hover:text-brand-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        <SlidersIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {!iconOnly && <span>Display</span>}
        {!iconOnly && <ChevronDownIcon className="h-3 w-3 shrink-0" aria-hidden="true" />}
        {activeFilterCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1.5 -right-1.5 min-w-[1rem] h-4 px-1 inline-flex items-center
              justify-center rounded-full bg-brand-primary text-xs font-semibold leading-none
              text-neutral-surface"
          >
            {activeFilterCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Display options"
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full mt-1 z-30 min-w-[200px]
            rounded-card border border-neutral-border bg-neutral-surface py-1"
        >
          {sections.map((section, si) => {
            const headingId = `${menuId}-${section.id}`;
            return (
              <div key={section.id} role="group" aria-labelledby={headingId}>
                {si > 0 && (
                  <div role="separator" className="my-1 border-t border-neutral-border" />
                )}
                <div
                  id={headingId}
                  className="px-3 pt-1 pb-0.5 text-xs font-semibold uppercase tracking-[.06em]
                    text-neutral-text-secondary"
                >
                  {section.label}
                </div>
                {section.rows.map((row) => {
                  flatIndex += 1;
                  const index = flatIndex;
                  return (
                    <button
                      key={row.id}
                      ref={(el) => {
                        itemRefs.current[index] = el;
                      }}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={row.checked}
                      tabIndex={index === activeIndex ? 0 : -1}
                      onClick={() => row.onChange(!row.checked)}
                      className="flex items-center w-full px-3 py-1.5 gap-2 text-left text-xs
                        text-neutral-text-primary hover:bg-neutral-surface-raised
                        focus-visible:outline-none focus-visible:bg-neutral-surface-raised"
                    >
                      <span className="flex-1">{row.label}</span>
                      <span
                        aria-hidden="true"
                        className="text-brand-primary w-3 text-right"
                      >
                        {row.checked ? '✓' : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
