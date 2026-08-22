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
 * Under prefers-reduced-motion the rings do not mount — the live-region
 * announcement carries the alternative feedback — but the latch below still
 * records the pulse, because reduced motion suppresses the animation, not the
 * targeting.
 */
export function MilestonePulseOverlay({ x, y, triggerId }: MilestonePulseOverlayProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Latched: records that a pulse was *requested* for this task and is never
  // cleared. The animating node below lives for 1.5 s, which makes it unusable
  // as a test signal — an assertion has to catch a window that has already
  // closed on a loaded runner (#2380). This outlives the animation, so a spec
  // can assert the outcome instead of racing it
  // (`feedback_e2e_assert_outcomes_not_transient_state`).
  const [pulsedId, setPulsedId] = useState<string | null>(null);

  useEffect(() => {
    if (!triggerId) return;
    // Latched before the reduced-motion bail: the deep link resolved and named
    // this milestone either way. Reduced motion suppresses the *animation*, not
    // the targeting, and a spec asking "did the deep link find the right
    // milestone" must not depend on whether the user animates.
    setPulsedId(triggerId);
    if (prefersReducedMotion()) return;
    setActiveId(triggerId);
    const t = setTimeout(() => setActiveId(null), DURATION_MS);
    return () => clearTimeout(t);
  }, [triggerId]);

  return (
    <>
      {/* Zero-footprint marker: `hidden` keeps it out of layout and the a11y
          tree. Empty string rather than absent when nothing has pulsed, so a
          spec can distinguish "no pulse yet" from "attribute missing". */}
      <span
        data-testid="milestone-pulse-latch"
        data-pulsed-task-id={pulsedId ?? ''}
        hidden
      />
      {activeId ? <PulseRings x={x} y={y} /> : null}
    </>
  );
}

/** The transient animation itself — mounted only while a pulse is playing. */
function PulseRings({ x, y }: { x: number; y: number }) {
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
