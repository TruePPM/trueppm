import { useCallback, useEffect, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent } from 'react';

export interface PausableAutoDismissOptions {
  /**
   * Whether a surface is currently on screen. `false` cancels any pending timer
   * AND clears the pause flags — a host that outlives its toast (the Schedule's
   * single renderer does; `ToastHost`'s per-id `ToastPill` does not) would
   * otherwise carry a stale `hovered`/`focused` into the next toast and never
   * dismiss it, because neither `mouseleave` nor `focusout` fires for an element
   * that was unmounted out from under the pointer.
   */
  active: boolean;
  /** Dwell in ms. Restarts the clock when it changes. */
  durationMs: number;
  /**
   * Identity/revision of the thing being timed. A change restarts the clock
   * without touching the pause flags, so an absorbed duplicate gets a fresh
   * window while a hovering pointer keeps its pause.
   */
  restartKey: unknown;
  /** Called when the dwell elapses un-paused. Read through a ref, so it need not be stable. */
  onDismiss: () => void;
  /**
   * Notified when focus enters or leaves the surface. `ToastHost` uses it to
   * claim `focusedId` in the store — D8 makes focus decide displacement, and
   * displacement is a store rule, not a local one.
   */
  onFocusWithinChange?: (focusWithin: boolean) => void;
}

/**
 * Spread onto the element that owns the dwell. Named so a component that PAINTS a
 * surface whose timer lives in its parent (`GridToast`) can take it as a prop.
 */
export interface PauseHandlers {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: (e: ReactFocusEvent<HTMLElement>) => void;
}

export interface PausableAutoDismissResult {
  /** True while hovered or containing focus. Exposed for assertions and styling. */
  paused: boolean;
  pauseHandlers: PauseHandlers;
}

/**
 * Auto-dismiss timer that pauses while its surface is hovered or contains focus.
 *
 * **WCAG 2.2.1 (Pause, Stop, Hide) and 2.4.3 (Focus Order).** A toast carrying an
 * Undo is the only route to that undo; if the dwell keeps running while a keyboard
 * or screen-reader user is still traversing toward the button, the surface unmounts
 * under the focused control and focus falls to `<body>`. So the countdown stops on
 * hover, stops on focus-within, and — the half that hover alone does not give you —
 * **an element with focus inside it is never auto-removed** (web rule 356(d)).
 *
 * Hover and focus are tracked separately on purpose: releasing one while the other
 * still holds must not resume the countdown. Leaving restarts the *full* duration
 * rather than resuming a stale remainder — a fresh, honest window.
 *
 * This is the single implementation of that invariant. It was extracted from
 * `ToastHost`'s `ToastPill`, which had it, when the Schedule's private
 * `ScheduleActionToastRenderer` was found not to (#3356): two surfaces that have
 * already diverged once on an accessibility guarantee will diverge again, and the
 * Schedule renders its own toast rather than the global host (see the
 * `trailBacked` discussion in `toastStore.ts`), so the renderers stay separate
 * even though the timer no longer does.
 *
 * No hover-state seeding on mount, deliberately — see the note in `ToastPill`
 * about `:hover` reading `false` on a replacement pill.
 */
export function usePausableAutoDismiss({
  active,
  durationMs,
  restartKey,
  onDismiss,
  onFocusWithinChange,
}: PausableAutoDismissOptions): PausableAutoDismissResult {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  // `onDismiss` is read through a ref so an inline arrow from the caller cannot
  // re-run the timer effect on every render — which would reset the countdown
  // forever and make the toast permanent.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  const focusWithinRef = useRef(onFocusWithinChange);
  useEffect(() => {
    focusWithinRef.current = onFocusWithinChange;
  }, [onFocusWithinChange]);

  // Clear the pause when the surface goes away — see `active` above.
  useEffect(() => {
    if (active) return;
    setHovered(false);
    setFocused(false);
  }, [active]);

  useEffect(() => {
    if (!active || paused) return;
    const handle = window.setTimeout(() => dismissRef.current(), durationMs);
    return () => window.clearTimeout(handle);
  }, [active, paused, durationMs, restartKey]);

  const onMouseEnter = useCallback(() => setHovered(true), []);
  const onMouseLeave = useCallback(() => setHovered(false), []);
  const onFocus = useCallback(() => {
    setFocused(true);
    focusWithinRef.current?.(true);
  }, []);
  const onBlur = useCallback((e: ReactFocusEvent<HTMLElement>) => {
    // Ignore focus moving between children of the same surface.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setFocused(false);
    focusWithinRef.current?.(false);
  }, []);

  return {
    paused,
    pauseHandlers: { onMouseEnter, onMouseLeave, onFocus, onBlur },
  };
}
