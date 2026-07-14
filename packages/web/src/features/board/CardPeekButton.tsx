import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Reusable tap-to-peek disclosure button for board cards (web-rule 256, #1947).
 *
 * On a coarse pointer, a board-card affordance whose meaning is otherwise
 * hover-only (a `title`/`aria-label` on a display span) or truncated (a clipped
 * title) has no touch-reachable channel. This component promotes such an
 * affordance to a real, tappable disclosure: a `<button aria-expanded
 * aria-controls>` that toggles a `role="note"` popover carrying the full text.
 *
 * The disclosure mechanics are the rule-253 contract established by
 * `PendingAcceptanceChip`'s `InteractivePendingChip`, extracted here so any
 * coarse-pointer card affordance can reuse them verbatim:
 *
 *   - popover is `createPortal`'d to `document.body` with `position: fixed`,
 *     coords derived from the trigger's `getBoundingClientRect()` — because the
 *     chip lives inside a board column whose card stack is `overflow-y-auto`
 *     (as narrow as 208px), an in-flow `absolute` popover would be clipped and
 *     `z-index` does not defeat an overflow-clipping ancestor;
 *   - flips above the trigger when there is no room below, clamps horizontally
 *     to the viewport;
 *   - closes on Escape ("Got it" too) with focus returned to the trigger;
 *   - closes on outside pointerdown WITHOUT stealing focus (checking both the
 *     trigger and the portaled popover, which is no longer a DOM descendant);
 *   - repositions on scroll(capture)/resize since a fixed popover cannot track
 *     its anchor;
 *   - `stopPropagation` on pointerdown+click so opening never drags, selects,
 *     or opens the host card;
 *   - `before:inset-[-12px]` for a ≥44px hit target; rule-4 `focus-visible` ring.
 *
 * The popover surface is intentionally NEUTRAL (rule 253a): the trigger may
 * carry a semantic tone (e.g. the worst-offender health badge), but the peek
 * itself explains only and never signals severity by color.
 *
 * NOTE: `PendingAcceptanceChip` is deliberately NOT refactored onto this
 * component in #1947 to keep its tests untouched; future consolidation of the
 * two is tracked in the MR description.
 */
interface Props {
  /** Rendered inside the trigger `<button>` (glyph + optional label). */
  triggerContent: ReactNode;
  /** Extra classes for the trigger — e.g. a semantic tone pill for the badge. */
  triggerClassName?: string;
  /** Accessible name of the closed trigger, e.g. "Blocked. What does this mean?". */
  ariaLabel: string;
  /** Accessible name of the opened popover (`role="note"`). */
  peekAriaLabel: string;
  /** The full text revealed inside the popover. */
  children: ReactNode;
  /** Dismissal copy — never an action verb (rule 253b). */
  closeLabel?: string;
}

/** Popover geometry — the same constants as the rule-253 reference. Height is a
 *  fixed estimate used only to decide whether to flip above. */
const POPOVER_WIDTH = 240;
const POPOVER_EST_HEIGHT = 120;
const VIEWPORT_MARGIN = 8;

export function CardPeekButton({
  triggerContent,
  triggerClassName,
  ariaLabel,
  peekAriaLabel,
  children,
  closeLabel = 'Got it',
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const noteId = useId();

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  // Compute the portaled popover's fixed coords from the trigger's rect: below
  // it, flipping above when there isn't room, clamped horizontally so it never
  // leaves the viewport.
  const reposition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const below = rect.bottom + 4;
    const flipUp = below + POPOVER_EST_HEIGHT > window.innerHeight - VIEWPORT_MARGIN;
    setPos({
      top: flipUp ? Math.max(VIEWPORT_MARGIN, rect.top - POPOVER_EST_HEIGHT - 4) : below,
      left: Math.max(
        VIEWPORT_MARGIN,
        Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN),
      ),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  // Escape closes and restores focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Click-outside closes without stealing focus (the user pointed elsewhere).
  // The check spans both the trigger and the portaled popover, since the popover
  // is no longer a DOM descendant of the trigger's wrapper.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // A fixed popover can't track its anchor on its own, so re-derive its coords
  // when the column/page scrolls or the viewport resizes.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  return (
    // Wrapper is a `<span>` (phrasing content) so the trigger stays valid inside
    // an inline card row; the popover itself is portaled out.
    <span className="inline-flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={noteId}
        // Discrete tap only — keep the drag sensors and card-open handler from
        // firing when the user reaches for the peek.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={[
          // `z-10` lifts the trigger (and its ≥44px hit pad) above the compact
          // card's always-visible `···` menu button, whose own `absolute`
          // `before:inset-[-10px]` pad otherwise paints over an adjacent inline
          // peek trigger and swallows the tap (#1947) — on touch that would make
          // the promoted affordance un-tappable, defeating the whole feature.
          'relative z-10 inline-flex items-center',
          triggerClassName ?? '',
          // Invisible ≥44px touch target without visually enlarging the trigger.
          "before:absolute before:inset-[-12px] before:content-['']",
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        ].join(' ')}
      >
        {triggerContent}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            role="note"
            id={noteId}
            aria-label={peekAriaLabel}
            style={{ position: 'fixed', top: pos.top, left: pos.left }}
            className="z-50 block w-max max-w-[240px] rounded-card border border-neutral-border
              bg-neutral-surface-raised px-3 py-2 text-left shadow-pop"
          >
            <span className="block whitespace-normal break-words text-xs leading-relaxed text-neutral-text-primary">
              {children}
            </span>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                close(true);
              }}
              className="mt-2 inline-flex items-center rounded-control border border-neutral-border
                px-2 py-1 text-xs font-medium text-neutral-text-secondary
                hover:bg-neutral-surface-sunken hover:text-neutral-text-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                focus-visible:ring-offset-1"
            >
              {closeLabel}
            </button>
          </div>,
          document.body,
        )}
    </span>
  );
}
