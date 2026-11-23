import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ZoomControl } from '../ZoomControl';
import { TOOLBAR_SPACER_ATTR } from '../toolbar/toolbarLadder';
import {
  ALWAYS_OVERFLOW,
  demotedCommands,
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

const BTN =
  'inline-flex h-8 shrink-0 items-center gap-1 rounded-control border border-neutral-border px-3 text-xs font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:opacity-50';
const BTN_ON = 'bg-brand-primary/10 border-brand-primary';

/**
 * A menu button whose popover is a `role="menu"`. Opening moves focus to the
 * first item; Arrow keys move; Escape and Tab close and hand focus back to the
 * trigger, so the toolbar's single tab stop is never lost inside a popover.
 */
function V2Menu({
  label,
  accessibleName,
  items,
  testId,
}: {
  label: ReactNode;
  accessibleName: string;
  items: V2MenuItem[];
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const focusables = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([aria-disabled="true"])',
      ) ?? [],
    );

  useEffect(() => {
    if (!open) return;
    focusables()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
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
      close(false);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // Keep the toolbar's roving handler from stealing focus out of the menu.
      e.stopPropagation();
    }
  };

  return (
    <div className="relative shrink-0">
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
      {open && (
        <div
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          aria-label={accessibleName}
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-30 mt-1 max-h-[min(70vh,28rem)] min-w-[14rem] overflow-y-auto rounded-control border border-neutral-border bg-neutral-surface py-1 shadow-pop"
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
                tabIndex={-1}
                onClick={select}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    select();
                  }
                }}
                className="flex min-h-[32px] cursor-pointer items-center gap-2 px-3 text-sm text-neutral-text-primary hover:bg-neutral-surface-raised focus:bg-neutral-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
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
        </div>
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
  // The count names commands, not menu rows: the five that always live here
  // plus whatever the ladder has demoted.
  const overflowCount = ALWAYS_OVERFLOW.length + demoted.length;
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
      className="flex h-11 shrink-0 items-center gap-2 overflow-hidden border-b border-neutral-border bg-neutral-surface px-3"
    >
      <V2Menu
        testId="schedule-v2-filter"
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
