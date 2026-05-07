import { useEffect, useState } from 'react';

export interface MilestonePulseOverlayProps {
  /** Pixel x in viewport-local coordinates (callers compute via dateToLeft). */
  x: number;
  /** Pixel y of the diamond's vertical center. */
  y: number;
  /** Triggers a fresh pulse when the value changes. Pass a unique id (the new
   *  milestone's task id) — the overlay self-clears 1.5 s after each new id. */
  triggerId: string | null;
}

const DURATION_MS = 1500;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * SVG overlay sibling to the canvas (#340). Two concentric circles fade outward
 * from the milestone diamond's location. Self-clears after 1.5 s.
 *
 * Does not mount at all under prefers-reduced-motion — the live-region
 * announcement carries the alternative feedback.
 */
export function MilestonePulseOverlay({ x, y, triggerId }: MilestonePulseOverlayProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!triggerId) return;
    if (prefersReducedMotion()) return;
    setActiveId(triggerId);
    const t = setTimeout(() => setActiveId(null), DURATION_MS);
    return () => clearTimeout(t);
  }, [triggerId]);

  if (!activeId) return null;

  return (
    <svg
      data-testid="milestone-pulse-overlay"
      aria-hidden="true"
      className="pointer-events-none absolute z-40"
      style={{ left: x - 24, top: y - 24, width: 48, height: 48 }}
      viewBox="0 0 48 48"
    >
      {/* Inner ring fires immediately, outer ring after 250 ms — staggered so
          the user perceives a wave, not a single ring. */}
      <circle
        cx={24}
        cy={24}
        fill="none"
        stroke="var(--brand-accent)"
        strokeWidth={2}
        className="animate-milestone-pulse"
      />
      <circle
        cx={24}
        cy={24}
        fill="none"
        stroke="var(--brand-accent)"
        strokeWidth={2}
        className="animate-milestone-pulse"
        style={{ animationDelay: '250ms' }}
      />
    </svg>
  );
}
