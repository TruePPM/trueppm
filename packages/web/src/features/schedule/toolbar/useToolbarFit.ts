/**
 * The Schedule toolbar's fit loop (#3076).
 *
 * Walks {@link TOOLBAR_LADDER} until the bar's contents measure narrower than
 * its box, then stops. This is deliberately a **measurement** loop rather than
 * a set of media queries: the natural width of the bar depends on the project's
 * own strings ("142 tasks · 9 critical" is not "3 tasks · 0 critical"), on the
 * rail being collapsed or not, on edit rights, and on which controls the person
 * pinned. A width table cannot know any of that, and every width it guessed
 * wrong would clip in silence — which is the defect this replaces.
 *
 * The `xl` / `2xl` Tailwind breakpoints still matter, but only for the
 * **first-paint composition** (see `firstPaintStep`), so nothing clips in the
 * frame before layout has been measured. After the first measurement the loop
 * owns the result.
 */
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  MAX_LADDER_STEP,
  measureToolbarContent,
  nextFitStep,
} from './toolbarLadder';

/**
 * Adjustments allowed per measurement pass before the loop stops for this frame.
 *
 * The loop provably converges — a rung only reverses once there is its own cost
 * plus hysteresis to spare — so hitting this cap means a rung failed to change
 * the measured width at all (a control that reported a stale box, say). Bailing
 * out leaves the bar at a slightly-too-compact composition, which is recoverable;
 * spinning would wedge the frame, which is not.
 */
const MAX_ADJUSTMENTS_PER_PASS = MAX_LADDER_STEP + 2;

/**
 * Composition to render before the first measurement lands.
 *
 * Seeded from the viewport because that is all that is knowable during the
 * first paint, and a too-compact first frame is invisible while a too-wide one
 * is a flash of clipped toolbar.
 */
export function firstPaintStep(viewportWidth: number): number {
  if (viewportWidth >= 1920) return 3;
  if (viewportWidth >= 1440) return 8;
  if (viewportWidth >= 1280) return 9;
  return MAX_LADDER_STEP;
}

export interface UseToolbarFitResult {
  /** How many ladder rungs are currently applied. */
  step: number;
  /** Re-run the loop after a change that alters natural width but not the box. */
  remeasure: () => void;
}

/**
 * @param ref The toolbar element. Must lay its children out with `flex-nowrap`
 *   and give every child `shrink-0`, or the children absorb the overflow by
 *   squeezing and the loop measures a bar that always "fits" while its labels
 *   wrap inside a 40px-tall strip.
 * @param enabled `false` parks the loop at step 0 (mobile renders no toolbar).
 * @param inventorySignature A value that changes whenever the bar's NATURAL
 *   width could have changed without its box changing — a pin toggled, edit
 *   rights resolving, the mode flipping, the trail gaining its first entry. A
 *   `ResizeObserver` cannot see any of those (the box is identical), so without
 *   this the loop would keep a composition chosen for an inventory that no
 *   longer exists — too compact after unpinning, or clipped after pinning.
 */
export function useToolbarFit(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
  inventorySignature = '',
): UseToolbarFitResult {
  const [step, setStep] = useState(() =>
    typeof window === 'undefined' ? 0 : firstPaintStep(window.innerWidth),
  );
  // Observed cost of each rung, indexed by rung. Beats the design's estimates
  // as soon as a rung has been applied once against this project's real strings.
  const costs = useRef<Array<number | undefined>>([]);
  // Measured content width at the step we last rendered, so the next pass can
  // difference the two and learn what the rung it just applied actually saved.
  const lastMeasure = useRef<{ step: number; content: number } | null>(null);
  const adjustments = useRef(0);
  const [tick, setTick] = useState(0);

  const remeasure = useCallback(() => {
    adjustments.current = 0;
    setTick((t) => t + 1);
  }, []);

  // Layout effect, not an effect: measuring after paint would show the user one
  // frame of the pre-fit composition on every change.
  useLayoutEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;

    const content = measureToolbarContent(el);
    const available = el.clientWidth;

    // An UNMEASURABLE bar is not a cramped bar. jsdom reports 0 for every box,
    // and so does a detached or `display:none` subtree — hold the pessimistic
    // first-paint seed there and the toolbar is permanently stuck at its
    // narrowest composition in every environment that never lays out. Snap back
    // to the roomy end instead: in a real browser this state lasts at most the
    // frame before the first layout effect measures, and nothing can clip in a
    // tree that is not being painted.
    if (available <= 0) {
      lastMeasure.current = null;
      if (step !== 0) setStep(0);
      return;
    }

    const prev = lastMeasure.current;
    if (prev && prev.step === step - 1 && costs.current[step - 1] === undefined) {
      const saved = prev.content - content;
      // Only trust a saving that actually happened; a rung measured as free
      // (or negative, mid-transition) keeps its estimate rather than teaching
      // the loop that undoing it is free.
      if (saved > 0) costs.current[step - 1] = saved;
    }
    lastMeasure.current = { step, content };

    const next = nextFitStep({
      step,
      contentWidth: content,
      availableWidth: available,
      costs: costs.current,
    });

    if (next !== step) {
      if (adjustments.current >= MAX_ADJUSTMENTS_PER_PASS) return;
      adjustments.current += 1;
      setStep(next);
      return;
    }
    adjustments.current = 0;
    // Deps are explicit rather than absent: an effect with no dependency array
    // re-runs on every render, which happens to work and hides WHICH changes
    // the loop actually depends on. `step` and `tick` drive the iteration;
    // `inventorySignature` is the one a ResizeObserver cannot supply.
  }, [enabled, ref, step, tick, inventorySignature]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      adjustments.current = 0;
      setTick((t) => t + 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);

  return { step: enabled ? step : 0, remeasure };
}
