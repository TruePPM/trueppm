/**
 * "A resize never strands focus." (#3076, build step 5)
 *
 * The fit ladder removes a control from the bar and renders it inside `···`.
 * If the person was *on* that control when it moved, two things go wrong at
 * once and only one of them is visible: DOM focus falls to `<body>` (so the
 * next Tab restarts from the top of the document), and nothing says where the
 * control went.
 *
 * Both halves are obligations, and satisfying the first is what makes it look
 * like you satisfied the second (rule 335): moving focus announces the
 * accessible name of whatever was focused — here, "More options" — which does
 * not tell anyone that *Add milestone* is the reason they are standing there.
 * So focus moves to the overflow trigger **and** a polite live region says
 * which control moved.
 *
 * Asymmetric on purpose: a **promotion** announces nothing and moves nothing. A
 * control gaining space is a gain, and interrupting someone to tell them they
 * have more room is noise.
 */
import { useEffect, useRef, type RefObject } from 'react';

export interface UseDemotionAnnounceArgs {
  /** The toolbar element, searched for the focused control. */
  toolbarRef: RefObject<HTMLElement | null>;
  /** The `···` trigger focus lands on when the focused control is demoted. */
  overflowTriggerRef: RefObject<HTMLElement | null>;
  /** Polite live region the sentence is written into. */
  liveRegionRef: RefObject<HTMLElement | null>;
  /** Current ladder step — the only thing that can move a control. */
  step: number;
  /** Human name of the overflow menu, as the sentence should call it. */
  overflowLabel?: string;
}

export function useDemotionAnnounce({
  toolbarRef,
  overflowTriggerRef,
  liveRegionRef,
  step,
  overflowLabel = 'More options',
}: UseDemotionAnnounceArgs): void {
  // The accessible name of whatever was focused inside the bar at the *previous*
  // step, captured before the re-render that may have removed it.
  const focusedName = useRef<string | null>(null);
  const prevStep = useRef(step);

  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      focusedName.current =
        target.getAttribute('aria-label') ?? target.textContent?.trim() ?? null;
    };
    const onFocusOut = (e: FocusEvent) => {
      // Only forget when focus genuinely left the bar. A demotion produces a
      // focusout with no relatedTarget (the node was removed), which is exactly
      // the case this hook exists for — so keep the name in that branch.
      if (e.relatedTarget instanceof Node && !toolbar.contains(e.relatedTarget)) {
        focusedName.current = null;
      }
    };
    toolbar.addEventListener('focusin', onFocusIn);
    toolbar.addEventListener('focusout', onFocusOut);
    return () => {
      toolbar.removeEventListener('focusin', onFocusIn);
      toolbar.removeEventListener('focusout', onFocusOut);
    };
  }, [toolbarRef]);

  useEffect(() => {
    const previous = prevStep.current;
    prevStep.current = step;
    // Only a descent can demote. A promotion is a gain and stays silent.
    if (step <= previous) return;

    const name = focusedName.current;
    if (!name) return;
    // Focus landing on <body> is the signal that the focused control was the
    // one removed. If focus is still on a real element, nothing was stranded.
    const active = document.activeElement;
    if (active && active !== document.body) return;

    overflowTriggerRef.current?.focus();
    if (liveRegionRef.current) {
      liveRegionRef.current.textContent = `${name} moved to ${overflowLabel}`;
    }
    focusedName.current = null;
  }, [step, overflowTriggerRef, liveRegionRef, overflowLabel]);
}
