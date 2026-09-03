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
 * Callers using this as a pure overflow menu render the trigger with `md:hidden`
 * per rule 112. Callers whose trigger IS the control — the mode chip, the zoom
 * cluster — pass no responsive class and are present at every width; for them the
 * popover holds the control's *acts*, and is not an overflow at all (#3263).
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { CheckIcon, ChevronDownIcon } from '@/components/Icons';

/**
 * Fields shared by both row kinds.
 *
 * `shortcut` / `ariaKeyShortcuts` exist for #3076: a control that has been
 * demoted out of the toolbar keeps its chord in the row, so the menu teaches
 * the way to stop needing the menu. They are the *same* strings the toolbar
 * button carries — a user who learned the shortcut never has to find the
 * control again, wherever the ladder has put it.
 */
interface ToolbarOverflowItemBase {
  id: string;
  label: string;
  disabled?: boolean;
  /** Optional leading glyph rendered as decorative text. */
  icon?: ReactNode;
  /** Display form of the chord, e.g. `⌥⌘M`. */
  shortcut?: string;
  /** WAI-ARIA form of the same chord, e.g. `Alt+Meta+M`. */
  ariaKeyShortcuts?: string;
}

export type ToolbarOverflowItem =
  | (ToolbarOverflowItemBase & {
      kind: 'action';
      onSelect: () => void;
    })
  | (ToolbarOverflowItemBase & {
      kind: 'checkbox';
      checked: boolean;
      onChange: (next: boolean) => void;
      /**
       * Close the popover after the toggle. Off by default because the usual
       * checkbox run is a set of filters someone flips several of in a row —
       * but a menu holding exactly ONE checkbox has no "in a row", and leaving
       * it open there costs a third interaction (open, toggle, dismiss) and
       * covers the trigger whose value just changed (#3263).
       */
      closeOnChange?: boolean;
    });

/**
 * A labeled run of items (#3076).
 *
 * Sections exist so a control the toolbar had no room for does not read as a
 * sibling of "Import from MS Project…". The heading is what draws that line;
 * `note` carries the reason on the same line ("no room at this width"), because
 * a user who lost a button is owed the *why* at the moment they find it again.
 */
export interface ToolbarOverflowSection {
  id: string;
  /** Heading text. Suppressed when this is the only surviving section. */
  label: string;
  /** Small explanatory clause rendered beside the heading. */
  note?: string;
  items: ToolbarOverflowItem[];
}

export interface ToolbarOverflowMenuProps {
  /** Items to render inside the popover, in display order. Ignored when
   *  `sections` is given. */
  items?: ToolbarOverflowItem[];
  /** Grouped items. Empty sections are dropped; headings render only when two
   *  or more sections survive, so a viewer whose entitlements left one group
   *  standing sees plain rows rather than a heading over each. */
  sections?: ToolbarOverflowSection[];
  /** Accessible label for the trigger button (defaults to "More options"). */
  triggerAriaLabel?: string;
  /**
   * Visible trigger content. Omitted renders the `⋯` glyph in a square button.
   * Supplied renders a labeled button — used by the collapsed clusters (#3076),
   * whose triggers must keep showing their *value* ("Month ▾", "Author") rather
   * than becoming an anonymous overflow dot.
   */
  triggerLabel?: ReactNode;
  /** Extra classes for the wrapping `<div>`. Use to control responsive
   *  visibility (callers typically pass `md:hidden`). */
  className?: string;
  /** Anchor edge for the popover. `right` keeps the menu inside the viewport
   *  when the trigger sits at the right edge of the toolbar. */
  align?: 'left' | 'right';
  /** Extra classes for the trigger button itself. */
  triggerClassName?: string;
  /**
   * `data-testid` for the trigger. Set it when the trigger IS the control —
   * a cluster whose trigger carries the value (`ScheduleModeChip`) is what a
   * spec drives, and locating it by accessible name couples every such spec to
   * the label's exact wording.
   */
  triggerTestId?: string;
  /**
   * `aria-keyshortcuts` for the TRIGGER. Rule 343(f) requires a control keep its
   * name *and* its chord; on a value-bearing trigger the chord would otherwise
   * live only on a row inside the popover, unreachable without opening it.
   */
  triggerAriaKeyShortcuts?: string;
  /** Rendered under the last section — the way out of the menu (#3076). */
  footer?: ReactNode;
  /**
   * Exposes the trigger so a caller can move focus to it — used when the fit
   * ladder demotes the control the user was standing on (#3076).
   */
  triggerRef?: MutableRefObject<HTMLButtonElement | null>;
}

export function ToolbarOverflowMenu({
  items,
  sections,
  triggerAriaLabel = 'More options',
  triggerLabel,
  className,
  align = 'right',
  triggerClassName,
  triggerTestId,
  triggerAriaKeyShortcuts,
  footer,
  triggerRef: externalTriggerRef,
}: ToolbarOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  // One ref, two owners: the caller's if it supplied one, else our own. Sharing
  // the object (rather than syncing two) is what keeps `close()`'s focus
  // restore and an external `.focus()` pointing at the same node.
  const triggerRef = externalTriggerRef ?? internalTriggerRef;
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  // One rendering model: a flat `items` list is a single unlabeled section, so
  // the roving-focus and keyboard code below never has to branch on which API
  // the caller used.
  const renderSections: ToolbarOverflowSection[] = (
    sections ?? [{ id: 'default', label: '', items: items ?? [] }]
  ).filter((s) => s.items.length > 0);
  // Headings only earn their space when they are distinguishing something.
  const showHeadings = renderSections.length > 1;
  const flatItems: ToolbarOverflowItem[] = renderSections.flatMap((s) => s.items);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, [triggerRef]);

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
  }, [open, triggerRef]);

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
      setActiveIndex(Math.max(0, flatItems.length - 1));
      setOpen(true);
    }
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (flatItems.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % flatItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + flatItems.length) % flatItems.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(flatItems.length - 1);
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
      // Checkbox items stay open so the user can toggle multiple in a row —
      // unless the caller says this one is the only thing in the menu worth
      // toggling, in which case staying open is just a dismissal to perform.
      //
      // `close()` and not `setOpen(false)`: it moves focus to the trigger before
      // React unmounts the row that had it, which is rule 368 — and the trigger
      // is the right destination because reopening the menu is what undoes this.
      if (item.closeOnChange) close();
    }
  }

  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        data-testid={triggerTestId}
        aria-label={triggerAriaLabel}
        aria-keyshortcuts={triggerAriaKeyShortcuts}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setActiveIndex(0);
          setOpen((v) => !v);
        }}
        onKeyDown={onTriggerKeyDown}
        className={
          triggerClassName ??
          [
            'inline-flex items-center justify-center shrink-0',
            triggerLabel === undefined ? 'h-7 w-7' : 'h-7 gap-1.5 px-2 text-xs font-medium',
            'rounded-control border border-neutral-border',
            'text-neutral-text-secondary hover:text-neutral-text-primary',
            'hover:bg-neutral-surface-raised',
            'focus:outline-none focus:ring-2',
            'focus:ring-brand-primary focus:ring-offset-1',
          ].join(' ')
        }
      >
        {triggerLabel === undefined ? (
          <span aria-hidden="true" className="text-[16px] leading-none">⋯</span>
        ) : (
          <>
            {triggerLabel}
            <ChevronDownIcon className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
          </>
        )}
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
            'absolute z-30 top-full mt-1 min-w-[200px] max-h-[min(70vh,32rem)]',
            'overflow-y-auto rounded-card border border-neutral-border bg-neutral-surface',
            'py-1',
            align === 'right' ? 'right-0' : 'left-0',
          ].join(' ')}
        >
          {renderSections.map((section, sectionIndex) => (
            // Rule 250: `role="group"` labeled *like* the header via `aria-label`,
            // with the visible header `aria-hidden` so AT hears the group name
            // once — as the group's label — rather than again as a stray text
            // node the roving sequence cannot reach.
            <div
              key={section.id}
              role="group"
              aria-label={showHeadings ? section.label : undefined}
            >
              {showHeadings && sectionIndex > 0 && (
                <div role="separator" className="my-1 border-t border-neutral-border" />
              )}
              {showHeadings && (
                <div aria-hidden="true" className="flex items-baseline gap-2 px-3 pt-1 pb-0.5">
                  <span className="text-xs font-semibold uppercase tracking-[.06em] text-neutral-text-secondary">
                    {section.label}
                  </span>
                  {section.note && (
                    <span className="text-xs font-normal normal-case text-neutral-text-secondary">
                      {section.note}
                    </span>
                  )}
                </div>
              )}
              {section.items.map(renderRow)}
            </div>
          ))}
          {footer && (
            <>
              <div role="separator" className="my-1 border-t border-neutral-border" />
              {footer}
            </>
          )}
        </div>
      )}
    </div>
  );

  /**
   * One row. Its roving index is its position in the *flattened* list, so
   * ArrowDown crosses a section boundary without noticing it — which is what
   * rule 112 promises and what section headings must not interrupt.
   */
  function renderRow(item: ToolbarOverflowItem) {
    const index = flatItems.indexOf(item);
    const baseCls = [
      'flex items-center w-full px-3 py-1.5 gap-2 text-left text-xs',
      'text-neutral-text-primary hover:bg-neutral-surface-raised',
      // Menu rows are a rule-214 carve-out: `focus:` so the pointer-focused
      // row shows its highlight in Firefox/Safari (WCAG 2.4.7).
      'focus:outline-none focus:bg-neutral-surface-raised',
      'disabled:opacity-50 disabled:cursor-not-allowed',
    ].join(' ');
    // The shortcut travels with the control (#3076): a demoted button teaches
    // the way to avoid the menu it is currently sitting in, and
    // `aria-keyshortcuts` keeps that identity position-independent.
    const shortcut = item.shortcut && (
      <span aria-hidden="true" className="ml-auto pl-3 text-neutral-text-disabled tppm-mono">
        {item.shortcut}
      </span>
    );
    if (item.kind === 'action') {
      return (
        <button
          key={item.id}
          ref={(el) => {
            itemRefs.current[index] = el;
          }}
          type="button"
          role="menuitem"
          tabIndex={index === activeIndex ? 0 : -1}
          disabled={item.disabled}
          aria-keyshortcuts={item.ariaKeyShortcuts}
          onClick={() => activate(item)}
          className={baseCls}
        >
          {item.icon && (
            <span aria-hidden="true" className="text-neutral-text-secondary">
              {item.icon}
            </span>
          )}
          <span>{item.label}</span>
          {shortcut}
        </button>
      );
    }
    return (
      <button
        key={item.id}
        ref={(el) => {
          itemRefs.current[index] = el;
        }}
        type="button"
        role="menuitemcheckbox"
        aria-checked={item.checked}
        tabIndex={index === activeIndex ? 0 : -1}
        disabled={item.disabled}
        aria-keyshortcuts={item.ariaKeyShortcuts}
        onClick={() => activate(item)}
        className={baseCls}
      >
        {item.icon && (
          <span aria-hidden="true" className="text-neutral-text-secondary">
            {item.icon}
          </span>
        )}
        <span className="flex-1">{item.label}</span>
        {item.shortcut && (
          <span aria-hidden="true" className="pl-3 text-neutral-text-disabled tppm-mono">
            {item.shortcut}
          </span>
        )}
        <span aria-hidden="true" className="flex w-3 shrink-0 justify-end text-brand-primary">
          {item.checked && <CheckIcon className="h-3 w-3" />}
        </span>
      </button>
    );
  }
}
