import { useEffect, useRef, useState } from 'react';
import { useToastStore } from './toastStore';
import type { ToastItem } from './toastStore';
import { CheckIcon } from '@/components/Icons';

/**
 * Global toast host (v2 fluidity, ADR-0126; issue 1225) — mounted once in
 * `AppShell`. Renders the store's two fixed slots (#3149, D5) as bottom-center
 * ink pills (prototype `.toast-wrap`/`.toast`). Each pill rises + fades in via
 * `motion-safe:animate-toast-rise` (rule 180/70) and auto-dismisses after its
 * `durationMs`.
 *
 * Slot order is the render order and it is deliberate: the **transient** slot
 * paints above, the **action** slot below — nearest the thumb, because the action
 * slot is the only one holding something to press. Each slot is rendered only
 * when it is full; the host never reserves height for an empty one, so a lone
 * toast sits exactly where a lone toast always sat.
 *
 * Accessibility (D7): the wrap is `role="status" aria-live="polite"
 * aria-atomic="false"` and it **contains** the rendered toasts — nothing is
 * written to it out of band. An announcement is therefore a consequence of
 * painting, which makes "announced but never shown" impossible by construction
 * rather than by discipline: a toast evicted before its first paint was never
 * announced and never is. `aria-atomic="false"` is what keeps a re-render of one
 * slot from re-reading the other slot's unchanged text. The wrap is
 * `pointer-events-none` so it never blocks the UI beneath, and it is mounted
 * permanently (not gated on toast count) so a toast's text is injected into an
 * already-present live region — a region mounted at the same instant as its
 * content is not reliably announced (#2203). `shadow-pop` is allowed here — a
 * toast is a pop surface, the standing exception to web rule 1 (no content
 * shadows).
 */
export function ToastHost() {
  const transient = useToastStore((s) => s.transient);
  const action = useToastStore((s) => s.action);
  return (
    <div
      className="pointer-events-none fixed bottom-[22px] left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2.5"
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      {transient ? <ToastPill key={transient.id} toast={transient} /> : null}
      {action ? <ToastPill key={action.id} toast={action} /> : null}
    </div>
  );
}

function ToastPill({ toast }: { toast: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const setFocusWithin = useToastStore((s) => s.setFocusWithin);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // WCAG 2.2.1: pause the auto-dismiss while the pill is hovered or contains
  // focus, so a keyboard/SR user can actually reach an Undo action before it
  // disappears. Hover and focus are tracked separately — releasing one while
  // the other still holds must not resume the countdown.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  // No hover-state seeding on mount, deliberately. A pill that REPLACES another
  // mounts under a cursor that never moved, which looks like it should lose the
  // hover pause — `mouseenter` fires on a crossing, and the pointer did not cross.
  // The browser closes that gap itself: Chromium re-runs hit-testing after the
  // layout change and dispatches `mouseover`/`mouseenter` to the element that is now
  // under the pointer, so React's handler above fires and the pause carries over.
  // `element.matches(':hover')` is NOT a usable fallback here — it still reads
  // `false` on the replacement a full second after the swap, so seeding from it
  // would be inert code with a comment claiming a guard it does not provide. The
  // behavior this paragraph is about is pinned in `e2e/toast-host.spec.ts`.

  useEffect(() => {
    if (paused) return;
    // Leaving restarts the full duration (a fresh, honest window) rather than
    // resuming a stale remainder. `revision` is in the dependency list so an
    // absorbed duplicate restarts the clock without remounting the pill — see
    // `ToastItem.revision`.
    timerRef.current = setTimeout(() => dismiss(toast.id), toast.durationMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.id, toast.durationMs, toast.revision, dismiss, paused]);

  const dismissNow = () => dismiss(toast.id);
  return (
    <div
      data-testid="toast-pill"
      data-toast-slot={toast.slot}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => {
        setFocused(true);
        // The store needs this too, not just the local pause: D8 makes focus decide
        // displacement, and displacement is a store rule.
        setFocusWithin(toast.id, true);
      }}
      onBlur={(e) => {
        // Ignore focus moving between children of the same pill.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setFocused(false);
        setFocusWithin(toast.id, false);
      }}
      className={[
        'pointer-events-auto flex items-center gap-2.5 rounded-[11px] bg-neutral-text-primary py-3 text-[13.5px] font-medium text-neutral-text-inverse shadow-pop motion-safe:animate-toast-rise',
        // Action toasts trim the right padding to seat the button; plain toasts
        // keep the original symmetric 18px so their layout is pixel-identical.
        toast.action ? 'pl-[18px] pr-3' : 'px-[18px]',
      ].join(' ')}
    >
      {/* Decorative sage check on success/info; the message text carries the
          announcement (aria-hidden). Sage flips with the pill: the pill is the
          inverse of the canvas, so light sage on the light-mode navy pill,
          darker sage on the dark-mode light pill. */}
      {toast.variant !== 'error' && (
        <CheckIcon
          className="text-sage-400 dark:text-sage-700 inline-block h-3 w-3 align-[-0.125em]"
          aria-hidden="true"
          data-testid="toast-success-check"
        />
      )}
      <span className={toast.action ? 'pr-1' : undefined}>
        {toast.message}
        {toast.count > 1 ? (
          <>
            {/* `×` is skipped outright by some screen readers and read as
                "multiplication sign" by others, so the count — which is real
                information, not decoration — gets a spoken form of its own
                rather than riding on the glyph. */}
            <span aria-hidden="true">{` ×${toast.count}`}</span>
            <span className="sr-only">{`, repeated ${toast.count} times`}</span>
          </>
        ) : null}
      </span>
      {toast.action ? (
        // Inline action (issue 1113 "Undo"). A real focusable button inside the live
        // region and in normal tab order — the region is aria-live=polite (announces
        // without stealing focus), so keyboard/SR users reach the action via Tab.
        // Runs the action then auto-dismisses the pill; the action's own onClick
        // decides any follow-up confirmation toast.
        <button
          type="button"
          aria-label={toast.action.ariaLabel ?? toast.action.label}
          onClick={() => {
            toast.action?.onClick();
            dismissNow();
          }}
          // The ring is `neutral-text-inverse`, not the house `brand-primary` of rule 4.
          // Rule 4's ring is measured against an ordinary canvas; this button sits on an
          // *inverse* ink pill, and sage measures 2.40:1 (light) / 2.00:1 (dark) against
          // it — under WCAG 1.4.11's 3:1 even at full alpha, so the `/70` this used to
          // carry was not the whole defect. `neutral-text-inverse` is the pill's own text
          // color and therefore its maximum-contrast ink: 14.2:1 and 15.0:1. That matters
          // more here than on an ordinary button, because focus on this control is not
          // decorative — it pauses the dwell and blocks displacement (D8), so an
          // invisible ring puts the user in a mode they cannot see and did not choose.
          className="ml-1 min-h-[44px] shrink-0 rounded-[8px] border-l border-neutral-text-inverse/25 pl-3 pr-1.5 font-semibold text-neutral-text-inverse hover:text-sage-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-text-inverse focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-text-primary dark:hover:text-sage-700"
        >
          {toast.action.label}
        </button>
      ) : null}
    </div>
  );
}
