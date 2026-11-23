import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { measureToolbarContent, nextFitStep } from '../toolbar/toolbarLadder';

/**
 * The measured fit loop of rule 343 for a ladder other than v1's (#4796).
 *
 * Same loop as `toolbar/useToolbarFit` — `ResizeObserver` + `nextFitStep` with
 * hysteresis, costs learned from what each rung actually saved — but seeded at
 * step 0 rather than from v1's viewport table, whose step numbers index v1's
 * ladder and would run off the end of a shorter one. Step 0 is safe as a first
 * paint because this runs in a layout effect: the user never sees the
 * unfitted frame. An unmeasurable bar (jsdom, `display:none`) snaps to 0, per
 * rule 343's last paragraph.
 */
export function useLadderFit(
  ref: RefObject<HTMLElement | null>,
  ladder: readonly { estimate: number }[],
  inventorySignature = '',
): number {
  const [step, setStep] = useState(0);
  const [tick, setTick] = useState(0);
  const costs = useRef<Array<number | undefined>>([]);
  const lastMeasure = useRef<{ step: number; content: number } | null>(null);
  const adjustments = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const content = measureToolbarContent(el);
    const available = el.clientWidth;
    if (available <= 0) {
      lastMeasure.current = null;
      if (step !== 0) setStep(0);
      return;
    }
    const prev = lastMeasure.current;
    if (prev && prev.step === step - 1 && costs.current[step - 1] === undefined) {
      const saved = prev.content - content;
      if (saved > 0) costs.current[step - 1] = saved;
    }
    lastMeasure.current = { step, content };
    const next = nextFitStep({
      step,
      contentWidth: content,
      availableWidth: available,
      costs: costs.current,
      ladder,
    });
    if (next !== step) {
      if (adjustments.current > ladder.length + 2) return;
      adjustments.current += 1;
      setStep(next);
      return;
    }
    adjustments.current = 0;
  }, [ref, step, tick, inventorySignature, ladder]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      adjustments.current = 0;
      setTick((t) => t + 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return step;
}
