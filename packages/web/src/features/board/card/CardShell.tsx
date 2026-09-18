import type { ReactNode, Ref } from 'react';
import type { Task } from '@/types';
import { accentBarClass } from './cardFormat';

interface CardShellProps {
  task: Task;
  /** Callback ref that both measures the card and wires dnd-kit's node ref. */
  cardRef: Ref<HTMLDivElement>;
  /** dnd-kit listeners (or the read-only substitutes) plus focus tracking. */
  dragProps: Record<string, unknown>;
  containerClass: string;
  showCriticalState: boolean;
  isFilteredOut: boolean;
  onCardClick?: (task: Task, anchor: HTMLElement) => void;
  children: ReactNode;
}

/**
 * The card root: the drag wiring, the whole-card click target, the left accent
 * bar, and the facet-filtered-out inert treatment. Shared by every rendered
 * density so the card's outer contract lives in exactly one place.
 *
 * It is deliberately a **plain, roleless container** (#2618). It used to be
 * `role="button"` + `tabIndex={0}` carrying the card's accessible name, which
 * made every real control the card holds — health badge, dependency and risk
 * chips, accept ✓, ··· overflow trigger — a focusable descendant of a `button`.
 * ARIA gives a button presentational children, so axe reported that as
 * `nested-interactive` (serious, WCAG 2.1 A 4.1.2) and the gate had to suppress
 * the rule for the whole Board scan. The card's name, its tab stop, and its
 * Enter/Space activation all moved to `CardTitleButton`, which contains nothing
 * focusable. Note what that means for the attributes below: a roleless element
 * is `generic`, and `generic` permits neither `aria-label` nor
 * `aria-roledescription` — so neither may come back here. `BoardCard` strips
 * dnd-kit's `role`/`tabIndex`/`aria-disabled`/`aria-roledescription` for the
 * same reason.
 *
 * `onClick` stays: clicking anywhere on the card still opens its detail. That is
 * a pointer affordance layered on a control that already exists, not the only
 * route to the action, so it needs no role of its own.
 */
export function CardShell({
  task,
  cardRef,
  dragProps,
  containerClass,
  showCriticalState,
  isFilteredOut,
  onCardClick,
  children,
}: CardShellProps) {
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the keyboard route is `CardTitleButton`, a real <button> inside this element carrying the card's name and its Enter/Space activation. Both rules exist to stop a div being the ONLY route to an action; here the div is a redundant pointer enlargement of a control that already exists. Giving it a role + tab stop to satisfy them is precisely the `nested-interactive` shape #2618 removed.
    <div
      ref={cardRef}
      {...dragProps}
      onClick={(e) => onCardClick?.(task, e.currentTarget)}
      className={containerClass}
      // `inert` (React 19 boolean prop) is the real fix (#2204): it removes a
      // facet-filtered-out card AND its inner buttons (title, ··· menu, signal
      // chips) from the tab order — `aria-hidden` alone did NOT (aria-hidden
      // hides from AT but does not remove focusability, so keyboard focus still
      // landed on cards the user filtered away). `aria-hidden` is retained
      // because inert is not yet modeled by every a11y tree consumer.
      inert={isFilteredOut || undefined}
      aria-hidden={isFilteredOut || undefined}
    >
      {/* Left accent bar — rounded-l-card matches card's border-radius so the bar
          respects the card corners without needing overflow-hidden on the parent. */}
      <div
        className={`absolute left-0 inset-y-0 w-1 rounded-l-card ${accentBarClass(task, showCriticalState)}`}
        aria-hidden="true"
      />
      {children}
    </div>
  );
}
