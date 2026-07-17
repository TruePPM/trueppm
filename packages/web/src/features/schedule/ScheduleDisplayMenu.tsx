/**
 * Schedule "Display" menu — the Show cluster of the Schedule toolbar (#1741).
 *
 * Houses the four view/render filters (CP only, Focus chain, Critical path,
 * Milestones), the optional column-visibility toggles, and the "Chart" section
 * (dependency lines, on-bar task-name placement, progress pills — #2097) behind a
 * single `Display ▾` trigger, so the toolbar stays at ≤6 top-level affordances
 * (rules 110–114, ADR-0064). This is the *permanent home* for the filters at
 * every width — they never migrate into the `···` overflow (web rule 243).
 *
 * Filters and column/chart checkboxes are `menuitemcheckbox` rows (multi-toggle,
 * menu stays open); the task-name placement is a `menuitemradio` group. The
 * trigger carries an active-count badge so "you are looking at a non-default
 * view" stays glanceable while the controls are folded away. The badge counts
 * the four *data* filters plus any *hidden* chart element (#2097) — hiding a
 * table column is a layout preference, not a data filter, so it never lights the
 * badge.
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
import type { ScheduleViewMode } from '@/stores/scheduleStore';
import type { TaskNamePlacement } from './engine';

/** A single checkbox toggle row inside the Display menu. */
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

/** Wiring for the "Chart" section (#2097) — what the canvas paints. */
export interface ChartMenuConfig {
  dependencyLinesVisible: boolean;
  setDependencyLinesVisible: (v: boolean) => void;
  /** The active view whose name placement this menu edits (#2107). Scopes the
   *  "Task names" sub-label and which placement options are offered. */
  viewMode: ScheduleViewMode;
  /** Placement for the active view (resolved by the host from its per-view map). */
  taskNamePlacement: TaskNamePlacement;
  setTaskNamePlacement: (v: TaskNamePlacement) => void;
  progressPillsVisible: boolean;
  setProgressPillsVisible: (v: boolean) => void;
}

const TASK_NAME_OPTIONS: ReadonlyArray<{ value: TaskNamePlacement; label: string }> = [
  { value: 'next', label: 'Next to bar' },
  { value: 'left', label: 'Aligned left' },
  { value: 'hidden', label: 'Hidden' },
];

// `left` (aligned-left name gutter, #2096) only exists in Timeline mode — in
// Grid the DOM task table already carries the names, so the option would be a
// no-op. Offer it only where it means something (#2107).
function taskNameOptionsFor(view: ScheduleViewMode) {
  return view === 'grid' ? TASK_NAME_OPTIONS.filter((o) => o.value !== 'left') : TASK_NAME_OPTIONS;
}

// Internal flattened, focusable menu item — checkbox or radio. Roving focus and
// keyboard nav operate over this uniform list regardless of source section.
type FlatItem =
  | { kind: 'checkbox'; id: string; label: string; checked: boolean; activate: () => void }
  | { kind: 'radio'; id: string; label: string; checked: boolean; activate: () => void };

// A rendered section may contain a nested radio group with its own sub-label.
interface RenderSection {
  id: string;
  label: string;
  items: FlatItem[];
  /** ids of items that begin a labeled radio sub-group, keyed to the sub-label. */
  radioGroup?: { afterItemId: string; label: string; itemIds: string[] } | null;
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
  /** Chart-render toggles (#2097), or null when the canvas is not applicable. */
  chart?: ChartMenuConfig | null;
  /** How many chart elements are hidden — added to the trigger badge count. */
  hiddenChartCount?: number;
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
  chart = null,
  hiddenChartCount = 0,
  iconOnly,
}: ScheduleDisplayMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const sections: RenderSection[] = [
    {
      id: 'view-filters',
      label: 'View filters',
      items: [
        {
          kind: 'checkbox',
          id: 'cp-only',
          label: 'CP only',
          checked: showCpOnly,
          activate: () => setShowCpOnly(!showCpOnly),
        },
        {
          kind: 'checkbox',
          id: 'focus-chain',
          label: 'Focus chain',
          checked: focusModeEnabled,
          activate: () => setFocusModeEnabled(!focusModeEnabled),
        },
      ],
    },
    {
      id: 'render-filters',
      label: 'Render filters',
      items: [
        {
          kind: 'checkbox',
          id: 'critical-path',
          label: 'Critical path',
          checked: showCriticalOnly,
          activate: () => setShowCriticalOnly(!showCriticalOnly),
        },
        {
          kind: 'checkbox',
          id: 'milestones',
          label: 'Milestones',
          checked: showMilestonesOnly,
          activate: () => setShowMilestonesOnly(!showMilestonesOnly),
        },
      ],
    },
  ];

  if (columns && columns.length > 0) {
    sections.push({
      id: 'columns',
      label: 'Columns',
      items: columns.map((c) => ({
        kind: 'checkbox' as const,
        id: c.id,
        label: c.label,
        checked: c.checked,
        activate: () => c.onChange(!c.checked),
      })),
    });
  }

  if (chart) {
    // The placement options and the sub-group label are both scoped to the
    // active view (#2107): Grid omits the Timeline-only `left` option, and the
    // label names the view so the value visibly differing across views reads as
    // intentional ("Task names (Grid)") rather than a bug.
    const taskNameOptions = taskNameOptionsFor(chart.viewMode);
    const radioIds = taskNameOptions.map((o) => `task-name-${o.value}`);
    const taskNamesLabel = `Task names (${chart.viewMode === 'grid' ? 'Grid' : 'Timeline'})`;
    sections.push({
      id: 'chart',
      label: 'Chart',
      items: [
        {
          kind: 'checkbox',
          id: 'dependency-lines',
          label: 'Dependency lines',
          checked: chart.dependencyLinesVisible,
          activate: () => chart.setDependencyLinesVisible(!chart.dependencyLinesVisible),
        },
        ...taskNameOptions.map((o) => ({
          kind: 'radio' as const,
          id: `task-name-${o.value}`,
          label: o.label,
          checked: chart.taskNamePlacement === o.value,
          activate: () => chart.setTaskNamePlacement(o.value),
        })),
        {
          kind: 'checkbox',
          id: 'progress-pills',
          label: 'Progress %',
          checked: chart.progressPillsVisible,
          activate: () => chart.setProgressPillsVisible(!chart.progressPillsVisible),
        },
      ],
      radioGroup: { afterItemId: 'dependency-lines', label: taskNamesLabel, itemIds: radioIds },
    });
  }

  // Flatten to a single roving list — section headings are not focusable.
  const items = sections.flatMap((s) => s.items);

  // Active-count badge: the four data filters plus any *hidden* chart element
  // (#2097) — a user who turned arrows/names/pills off isn't left wondering why
  // the canvas looks different. Column visibility stays excluded (layout, not data).
  const activeFilterCount =
    [showCpOnly, focusModeEnabled, showCriticalOnly, showMilestonesOnly].filter(Boolean).length +
    Math.max(0, hiddenChartCount);

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
    // Clamp: the focusable item count varies with the active view (#2107 — Grid
    // offers 2 name-placement radios, Timeline 3, and the Columns section is
    // Grid-only). If the list shrinks while the menu is open (e.g. a device
    // rotation flips the effective view), a stale activeIndex would point past
    // the array and drop focus to <body>; clamp it back into range instead.
    const index = Math.min(activeIndex, items.length - 1);
    itemRefs.current[index]?.focus();
  }, [open, activeIndex, items.length]);

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
      setOpen(false);
    }
  }

  // Track the running flat index so each item can map to its roving position.
  let flatIndex = -1;

  function renderItem(item: FlatItem) {
    flatIndex += 1;
    const index = flatIndex;
    return (
      <button
        key={item.id}
        ref={(el) => {
          itemRefs.current[index] = el;
        }}
        type="button"
        role={item.kind === 'radio' ? 'menuitemradio' : 'menuitemcheckbox'}
        aria-checked={item.checked}
        tabIndex={index === activeIndex ? 0 : -1}
        onClick={item.activate}
        className="flex items-center w-full px-3 py-1.5 gap-2 text-left text-xs
          text-neutral-text-primary hover:bg-neutral-surface-raised
          focus-visible:outline-none focus-visible:bg-neutral-surface-raised"
      >
        <span className="flex-1">{item.label}</span>
        <span aria-hidden="true" className="text-brand-primary w-3 text-right">
          {item.checked ? (item.kind === 'radio' ? '●' : '✓') : ''}
        </span>
      </button>
    );
  }

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
            const radioGroup = section.radioGroup ?? null;
            const radioIdSet = new Set(radioGroup?.itemIds ?? []);
            const radioGroupId = `${menuId}-${section.id}-radio`;
            // Items that belong to the radio sub-group are rendered together inside
            // a role="group" so screen readers announce them as one radio set.
            return (
              <div key={section.id} role="group" aria-labelledby={headingId}>
                {si > 0 && <div role="separator" className="my-1 border-t border-neutral-border" />}
                <div
                  id={headingId}
                  className="px-3 pt-1 pb-0.5 text-xs font-semibold uppercase tracking-[.06em]
                    text-neutral-text-secondary"
                >
                  {section.label}
                </div>
                {section.items.map((item) => {
                  const isFirstRadio = radioGroup?.itemIds[0] === item.id;
                  if (isFirstRadio && radioGroup) {
                    return (
                      <div key={`${item.id}-group`} role="group" aria-labelledby={radioGroupId}>
                        <div
                          id={radioGroupId}
                          className="px-3 pt-1 pb-0.5 text-xs font-medium
                            text-neutral-text-secondary"
                        >
                          {radioGroup.label}
                        </div>
                        {section.items.filter((it) => radioIdSet.has(it.id)).map(renderItem)}
                      </div>
                    );
                  }
                  // Skip radio items after the first — rendered inside the group above.
                  if (radioIdSet.has(item.id)) return null;
                  return renderItem(item);
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
