import type { Ref } from 'react';
import type { Task } from '@/types';
import { cardTitleToneClass, cpTooltip } from './cardFormat';
import type { BoardCardView } from './useBoardCardView';

interface CardTitleButtonProps {
  task: Task;
  view: BoardCardView;
  /** Density-specific title typography (`truncate` at compact, `line-clamp-2` above). */
  className: string;
  /** Compact density measures this node to decide whether the title overflows. */
  titleRef?: Ref<HTMLButtonElement>;
}

/**
 * The card's task title, rendered as the card's ONE interactive control.
 *
 * Why a button and not the span it replaced (#2618): the card root used to be
 * `role="button"` wrapping the whole card, and the card carries real focusable
 * controls — the health badge, the dependency/risk chips, the accept ✓, and the
 * ··· overflow trigger. ARIA gives a `button` presentational children, so that
 * shape is `nested-interactive` (axe serious, WCAG 2.1 A 4.1.2): the nested
 * controls are not reliably reachable, which is the opposite of what #3619 just
 * built. The root is now a plain container and this is the card's tab stop.
 *
 * It carries `view.cardLabel` — the exact string the root used to expose — so
 * the card's accessible name is unchanged and every
 * `getByRole('button', { name: /…% complete/ })` locator still resolves.
 * `aria-roledescription="draggable"` moves here with it (an element with no role
 * may not carry one, and a roleless root is what the fix leaves behind).
 *
 * Clicking it does not open the card itself — the click bubbles to the card
 * root's `onClick`, which is still the whole-card open-detail target. Keyboard
 * Enter/Space reach the same handler through native button activation, which is
 * the path the root's hand-rolled key handler used to fake.
 */
export function CardTitleButton({ task, view, className, titleRef }: CardTitleButtonProps) {
  return (
    <button
      ref={titleRef}
      type="button"
      // The card root's keyboard-focus effect (#2194) finds this button through
      // `data-card-title` — the root itself has no tab stop to hand focus to.
      data-card-title=""
      // The whole card opens on click (card root) — this button exists so the
      // same action has a real, announced, keyboard-reachable control. No
      // onClick of its own: one would double-fire alongside the root's.
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        // Compact density stops Enter/Space here so the window-level board
        // keyboard registry doesn't also claim it (#2194). Never
        // `preventDefault()`: that would suppress the native activation this
        // button relies on.
        if (view.isCompact) e.stopPropagation();
      }}
      className={[
        'text-left bg-transparent p-0 m-0 border-0',
        // The card outline is drawn by the root's `focus-within` ring, so this
        // control does not draw a second one around the title text.
        'focus:outline-none',
        className,
        cardTitleToneClass(view.showCriticalState, view.isIdea),
      ].join(' ')}
      title={view.showCriticalState ? cpTooltip(task) : task.name}
      aria-label={view.cardLabel}
      aria-roledescription={view.isDraggable ? 'draggable' : undefined}
    >
      {task.name}
    </button>
  );
}
