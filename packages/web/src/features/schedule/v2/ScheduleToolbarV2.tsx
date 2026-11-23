import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
import { ZoomControl } from '../ZoomControl';
import { TOOLBAR_SPACER_ATTR } from '../toolbar/toolbarLadder';
import {
  demotedCommands,
  overflowCommandCount,
  overflowLabel,
  resolveV2Composition,
  SCHEDULE_V2_LADDER,
  type ScheduleV2Composition,
} from './scheduleV2Ladder';
import { useLadderFit } from './useLadderFit';

/** One row of a v2 toolbar menu. */
export type V2MenuItem =
  | { kind: 'heading'; label: string }
  | { kind: 'item'; label: string; onSelect: () => void; disabled?: boolean; shortcut?: string }
  | { kind: 'checkbox'; label: string; checked: boolean; onSelect: () => void; disabled?: boolean };

/**
 * The 44x44 hit target of rule 5, built per rule 330: a `before:` box SIZED
 * from explicit lengths and centered on the control, never `inset`-ed (an
 * inset box resolves against the padding box and comes out `2×border` short).
 * The control keeps its 32px visual height, so the measured ladder's widths
 * are unchanged; the cushion only adds hit area above and below, and to the
 * sides of a control narrower than 44px (the icon-only Add task).
 */
export const HIT_TARGET =
  "relative before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-[max(100%,2.75rem)] before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

/** Menu panel width; the anchored popover clamps it to the viewport. */
const MENU_WIDTH = 256;

const BTN = `${HIT_TARGET} inline-flex h-8 shrink-0 items-center gap-1 rounded-control border border-neutral-border px-3 text-xs font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:opacity-50`;
const BTN_ON = 'bg-brand-primary/10 border-brand-primary';

/**
 * A menu button whose popover is a `role="menu"`. Opening moves focus to the
 * first item; Arrow keys move; Escape closes and hands focus back to the
 * trigger, and Tab closes and continues from the trigger, so the toolbar's
 * single tab stop is never lost inside a popover.
 *
 * The panel is portaled to `document.body` and positioned by
 * `useAnchoredPopover` (web-rule 253): rendered inside the 44px bar it was
 * clipped by the bar's overflow, so its items were present and "visible" to
 * Playwright but not hittable by a pointer.
 */
function V2Menu({
  label,
  accessibleName,
  items,
  testId,
  align,
}: {
  label: ReactNode;
  accessibleName: string;
  items: V2MenuItem[];
  testId: string;
  align: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  // Roving tabindex inside the menu: the item holding focus is the one with
  // tabIndex 0. It also keeps the scrollable panel keyboard-reachable for axe's
  // scrollable-region-focusable, which does not count tabIndex -1 descendants.
  const firstEnabled = items.find((it) => it.kind !== 'heading' && !it.disabled)?.label ?? null;
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const rovingLabel = activeItem ?? firstEnabled;
  const dismiss = useCallback(() => setOpen(false), []);
  const { triggerRef, popoverRef, popoverStyle } = useAnchoredPopover<
    HTMLButtonElement,
    HTMLDivElement
  >({ open, width: MENU_WIDTH, estimatedHeight: 320, align, onDismiss: dismiss });

  const focusables = () =>
    Array.from(
      popoverRef.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([aria-disabled="true"])',
      ) ?? [],
    );

  useEffect(() => {
    if (!open) setActiveItem(null);
    if (open) focusables()[0]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = focusables();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      list[(i + d + list.length) % list.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      (e.key === 'Home' ? list[0] : list[list.length - 1])?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      // The portaled panel sits at the end of <body>, so the browser's own Tab
      // would leave the page. Hand focus to the trigger first; the default
      // action then moves on from there.
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // React events bubble through the portal: keep the toolbar's roving
      // handler from stealing focus out of the menu.
      e.stopPropagation();
    }
  };

  // The hook's maxHeight is the real gap to the viewport edge (web-rule 351);
  // the design's own cap still applies on a tall window.
  const panelStyle =
    popoverStyle &&
    ({
      ...popoverStyle,
      maxHeight:
        typeof popoverStyle.maxHeight === 'number'
          ? `min(${popoverStyle.maxHeight}px, 70vh, 28rem)`
          : 'min(70vh, 28rem)',
    } as const);

  return (
    <div className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        className={BTN}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={accessibleName}
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {panelStyle &&
        createPortal(
          <div
            ref={popoverRef}
            role="menu"
            tabIndex={-1}
            aria-label={accessibleName}
            data-testid={`${testId}-menu`}
            onKeyDown={onMenuKey}
            style={panelStyle}
            className="z-50 max-h-[min(70vh,28rem)] overflow-y-auto rounded-control border border-neutral-border bg-neutral-surface py-1 shadow-pop"
          >
            {items.map((it, idx) => {
              if (it.kind === 'heading') {
                return (
                  <div
                    key={`h-${idx}`}
                    role="presentation"
                    className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary"
                  >
                    {it.label}
                  </div>
                );
              }
              const select = () => {
                if (it.disabled) return;
                it.onSelect();
                close(true);
              };
              return (
                <div
                  key={it.label}
                  role={it.kind === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'}
                  aria-checked={it.kind === 'checkbox' ? it.checked : undefined}
                  aria-disabled={it.disabled ? true : undefined}
                  aria-keyshortcuts={it.kind === 'item' ? it.shortcut : undefined}
                  tabIndex={it.label === rovingLabel ? 0 : -1}
                  onFocus={() => setActiveItem(it.label)}
                  onClick={select}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      select();
                    }
                  }}
                  // Rows are 44px tall (rule 5), not 32px with a cushion:
                  // stacked rows' cushions would overlap one another, so each
                  // row would still own only a 32px band of the pointer.
                  className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm text-neutral-text-primary hover:bg-neutral-surface-raised focus:bg-neutral-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                >
                  {it.kind === 'checkbox' && (
                    <span aria-hidden="true" className="w-3">
                      {it.checked ? '✓' : ''}
                    </span>
                  )}
                  {it.label}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

export interface ScheduleToolbarV2Props {
  onFit: () => void;
  canAddTask: boolean;
  onAddTask: () => void;
  createPending: boolean;
  onToday: () => void;
  /** False when the project has no active baseline: the toggle is then absent. */
  baselineAvailable: boolean;
  baselineShown: boolean;
  onToggleBaseline: () => void;
  criticalOnly: boolean;
  onToggleCriticalOnly: () => void;
  milestonesOnly: boolean;
  onToggleMilestonesOnly: () => void;
  /** Is there a selection to group? Disabled, with the act still named, when not. */
  canGroup: boolean;
  /** Absent for a reader without edit rights: the act is then not offered at all. */
  onGroup?: () => void;
  columns: { key: string; label: string; visible: boolean }[];
  onToggleColumn: (key: string) => void;
  onExpandAll: () => void;
  dependencyLinesShown: boolean;
  onToggleDependencyLines: () => void;
  exportItems: { label: string; onSelect: () => void; disabled?: boolean }[];
  /** Rendered in the bar while the ladder keeps it there. */
  legend: (placement: 'bar') => ReactNode;
  /** Told when the legend relocates, so the timeline header can host it. */
  onLegendPlacementChange: (placement: ScheduleV2Composition['legend']) => void;
}

/**
 * The shell v2 Schedule toolbar (#4796): three primary controls that never
 * fold, three inline ones that demote by the measured ladder of rule 343, and
 * a labeled overflow whose accessible name carries its count.
 *
 * Keyboard: a single tab stop with roving focus (WAI-ARIA toolbar pattern) —
 * Arrow Left/Right/Home/End move between controls; a popover's own keys stay
 * inside it.
 */
export function ScheduleToolbarV2(props: ScheduleToolbarV2Props) {
  const ref = useRef<HTMLDivElement>(null);
  const signature = `${props.baselineAvailable}|${props.canAddTask}`;
  const step = useLadderFit(ref, SCHEDULE_V2_LADDER, signature);
  const c = resolveV2Composition(step);
  const { onLegendPlacementChange } = props;

  useEffect(() => {
    onLegendPlacementChange(c.legend);
  }, [c.legend, onLegendPlacementChange]);

  const rovingItems = useCallback(
    () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>('button, select, [role="combobox"]') ?? [],
      ).filter((el) => !el.closest('[role="menu"], [role="dialog"], [role="listbox"]')),
    [],
  );
  const current = useRef(0);

  // Re-applied after every render: the ladder changes which controls exist,
  // and a demoted control that held the stop would otherwise leave none.
  useLayoutEffect(() => {
    const items = rovingItems();
    if (items.length === 0) return;
    if (current.current >= items.length) current.current = 0;
    items.forEach((el, i) => el.setAttribute('tabindex', i === current.current ? '0' : '-1'));
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const items = rovingItems();
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    let next: number;
    if (e.key === 'ArrowRight') next = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else next = items.length - 1;
    items[i].setAttribute('tabindex', '-1');
    items[next].setAttribute('tabindex', '0');
    current.current = next;
    items[next].focus();
  };

  const onFocus = () => {
    const i = rovingItems().indexOf(document.activeElement as HTMLElement);
    if (i >= 0) current.current = i;
  };

  const demoted = demotedCommands(c, props.baselineAvailable);
  const demotedItems: V2MenuItem[] = demoted.map((d) => {
    if (d === 'today') return { kind: 'item', label: 'Today', onSelect: props.onToday };
    if (d === 'baseline')
      return {
        kind: 'checkbox',
        label: 'Baseline',
        checked: props.baselineShown,
        onSelect: props.onToggleBaseline,
      };
    return {
      kind: 'checkbox',
      label: 'Critical only',
      checked: props.criticalOnly,
      onSelect: props.onToggleCriticalOnly,
    };
  });

  const overflowItems: V2MenuItem[] = [
    ...(demotedItems.length > 0
      ? [
          { kind: 'heading', label: 'Moved here: no room at this width' } as V2MenuItem,
          ...demotedItems,
        ]
      : []),
    { kind: 'heading', label: 'Structure' },
    ...(props.onGroup
      ? [
          {
            kind: 'item',
            label: 'Group',
            onSelect: props.onGroup,
            disabled: !props.canGroup,
          } as V2MenuItem,
        ]
      : []),
    { kind: 'item', label: 'Expand all', onSelect: props.onExpandAll },
    {
      kind: 'checkbox',
      label: 'Dependency links',
      checked: props.dependencyLinesShown,
      onSelect: props.onToggleDependencyLines,
    },
    { kind: 'heading', label: 'Columns' },
    ...props.columns.map<V2MenuItem>((col) => ({
      kind: 'checkbox',
      label: col.label,
      checked: col.visible,
      onSelect: () => props.onToggleColumn(col.key),
    })),
    { kind: 'heading', label: 'Export' },
    ...props.exportItems.map<V2MenuItem>((x) => ({ kind: 'item', ...x })),
  ];
  // The count names commands, not menu rows, and only the commands this menu
  // actually renders: Group is absent for a reader without edit rights, and a
  // count that included it would name an item the reader cannot find.
  const overflowCount = overflowCommandCount({
    group: props.onGroup !== undefined,
    columns: props.columns.length > 0,
    exportItems: props.exportItems.length > 0,
    demoted: demoted.length,
  });
  const activeFilters = props.milestonesOnly ? 1 : 0;

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Schedule toolbar"
      data-testid="schedule-toolbar-v2"
      data-fit-step={step}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      // `overflow-x-clip`, not `overflow-hidden`: the bar must never spill
      // sideways, but `hidden` also clipped the controls' 44px hit cushions
      // (rule 330) at the bar's top and bottom edge. Menus are portaled.
      className="flex h-11 shrink-0 items-center gap-2 overflow-x-clip border-b border-neutral-border bg-neutral-surface px-3"
    >
      <V2Menu
        testId="schedule-v2-filter"
        align="left"
        label={activeFilters > 0 ? `Filter · ${activeFilters}` : 'Filter'}
        accessibleName={activeFilters > 0 ? `Filter, ${activeFilters} active` : 'Filter'}
        items={[
          {
            kind: 'checkbox',
            label: 'Milestones only',
            checked: props.milestonesOnly,
            onSelect: props.onToggleMilestonesOnly,
          },
        ]}
      />
      <div className="shrink-0">
        <ZoomControl onFit={props.onFit} collapsed={c.zoom === 'select'} />
      </div>
      {props.canAddTask && (
        <button
          type="button"
          className={`${BTN} border-brand-primary bg-brand-primary text-white dark:text-navy-900 hover:bg-brand-primary/90`}
          onClick={props.onAddTask}
          disabled={props.createPending}
          aria-label={c.addTask === 'icon' ? 'Add task' : undefined}
          data-testid="schedule-v2-add-task"
        >
          <span aria-hidden="true">+</span>
          {c.addTask === 'labeled' && <span>Add task</span>}
        </button>
      )}
      {c.today === 'bar' && (
        <button
          type="button"
          className={BTN}
          onClick={props.onToday}
          data-testid="schedule-v2-today"
        >
          Today
        </button>
      )}
      {props.baselineAvailable && c.baseline === 'bar' && (
        <button
          type="button"
          className={`${BTN} ${props.baselineShown ? BTN_ON : ''}`}
          aria-pressed={props.baselineShown}
          onClick={props.onToggleBaseline}
          data-testid="schedule-v2-baseline"
        >
          Baseline
        </button>
      )}
      {c.criticalOnly === 'bar' && (
        <button
          type="button"
          className={`${BTN} ${props.criticalOnly ? BTN_ON : ''}`}
          aria-pressed={props.criticalOnly}
          onClick={props.onToggleCriticalOnly}
          data-testid="schedule-v2-critical-only"
        >
          Critical only
        </button>
      )}
      <span {...{ [TOOLBAR_SPACER_ATTR]: '' }} aria-hidden="true" className="flex-1" />
      {c.legend === 'bar' && props.legend('bar')}
      <V2Menu
        testId="schedule-v2-overflow"
        align="right"
        label={
          <>
            More <span aria-hidden="true">· {overflowCount}</span>
          </>
        }
        accessibleName={overflowLabel(overflowCount)}
        items={overflowItems}
      />
    </div>
  );
}
