import { useLayoutEffect, useState } from 'react';

export interface PopoverPosition {
  /** Computed left in viewport px. */
  left: number;
  /** Computed top in viewport px. */
  top: number;
  /** Whether the popover flipped to render above the anchor. */
  placement: 'bottom-start' | 'top-start' | 'bottom-end' | 'top-end';
}

const POPOVER_WIDTH = 360;
const VIEWPORT_PAD = 8;
const ANCHOR_GAP = 6;

/**
 * Compute viewport-clamped position for the desktop popover anchored to a
 * board card. Default placement is `bottom-start` — popover top-left aligns
 * to anchor bottom-left. Flips vertically when clipped at the viewport
 * bottom; flips horizontally (end-aligned) when the popover would overflow
 * the right edge.
 *
 * Recomputes on resize, scroll (capture-phase), and on `anchor` identity
 * change. Returns `null` until the first measurement settles, so callers
 * can render hidden until coordinates are known and avoid a paint at (0,0).
 */
export function useCardPopoverPosition(
  anchor: HTMLElement | null,
  popoverHeight: number,
): PopoverPosition | null {
  const [pos, setPos] = useState<PopoverPosition | null>(null);

  useLayoutEffect(() => {
    if (!anchor) {
      setPos(null);
      return undefined;
    }

    let raf: number | null = null;

    const measure = () => {
      raf = null;
      if (!anchor.isConnected) {
        setPos(null);
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const flipUp = rect.bottom + ANCHOR_GAP + popoverHeight + VIEWPORT_PAD > vh
        && rect.top - ANCHOR_GAP - popoverHeight >= VIEWPORT_PAD;
      const flipEnd = rect.left + POPOVER_WIDTH + VIEWPORT_PAD > vw;

      const top = flipUp
        ? Math.max(VIEWPORT_PAD, rect.top - ANCHOR_GAP - popoverHeight)
        : Math.min(vh - popoverHeight - VIEWPORT_PAD, rect.bottom + ANCHOR_GAP);
      const rawLeft = flipEnd ? rect.right - POPOVER_WIDTH : rect.left;
      const left = Math.max(
        VIEWPORT_PAD,
        Math.min(vw - POPOVER_WIDTH - VIEWPORT_PAD, rawLeft),
      );

      const placement: PopoverPosition['placement'] = flipUp
        ? (flipEnd ? 'top-end' : 'top-start')
        : (flipEnd ? 'bottom-end' : 'bottom-start');

      setPos({ left, top, placement });
    };

    const schedule = () => {
      if (raf !== null) return;
      raf = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      if (raf !== null) window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [anchor, popoverHeight]);

  return pos;
}

export const __testing = { POPOVER_WIDTH, VIEWPORT_PAD, ANCHOR_GAP };
