/**
 * Space-held click-drag panning for a scroll container (issue 1265).
 *
 * Holding Space arms "pan mode": the cursor switches to a grab hand and a
 * click-drag scrolls the container instead of selecting text or (on the board)
 * lifting a card. Releasing Space restores normal behavior. Panning is a
 * pointer *enhancement* layered on top of native scroll — the wheel, scrollbar,
 * and keyboard scroll paths are untouched, so keyboard-only and screen-reader
 * users are unaffected.
 *
 * The @dnd-kit precedence problem is solved with {@link SpaceAwarePointerSensor}:
 * while Space is held, the sensor's activator returns `false`, so a pointer-down
 * on a card never starts a drag and instead flows through to the pan handler. On
 * release the predicate flips back and normal drag behavior resumes with no
 * teardown — the sensor is only *gated*, never mutated.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject, PointerEvent as ReactPointerEvent } from 'react';
import { PointerSensor, type PointerSensorOptions } from '@dnd-kit/core';

import { isTypingInInput } from './useGlobalShortcut';

/**
 * Options for {@link SpaceAwarePointerSensor}, extending the stock
 * `PointerSensorOptions` with a live suppression predicate.
 */
export interface SpaceAwarePointerSensorOptions extends PointerSensorOptions {
  /**
   * When it returns `true`, pointer-down must NOT start a drag. Read on every
   * activation so it always reflects the current pan-mode state without the
   * sensor being re-created.
   */
  shouldSuppressActivation?: () => boolean;
}

/**
 * A drop-in replacement for @dnd-kit's `PointerSensor` that yields to Space-held
 * pan mode. Its activator mirrors the stock handler (primary button only) but
 * bails out first when `shouldSuppressActivation()` is true, letting the pan
 * gesture take precedence over card drag.
 */
export class SpaceAwarePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: (
        { nativeEvent: event }: ReactPointerEvent,
        options: SpaceAwarePointerSensorOptions,
      ): boolean => {
        if (options.shouldSuppressActivation?.()) return false;
        if (!event.isPrimary || event.button !== 0) return false;
        // Access via `options` (not destructured) so lint's unbound-method rule
        // doesn't flag the method-typed `onActivation` property.
        options.onActivation?.({ event });
        return true;
      },
    },
  ];
}

/**
 * Reports whether a Space keydown must be ignored (no pan, no scroll hijack).
 *
 * Blocked when: the event originates from a text-entry surface (input, textarea,
 * select, contenteditable detail editor, combobox); any modal dialog is open
 * (its Space belongs to the dialog); or focus sits on a control that natively
 * uses Space to activate — so keyboard-only users keep Space as their activation
 * key rather than having it hijacked for a pointer-only enhancement.
 */
function isSpacePanBlocked(target: EventTarget | null): boolean {
  if (isTypingInInput(target)) return true;
  if (typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]')) {
    return true;
  }
  if (
    target instanceof HTMLElement &&
    target.closest(
      'button, a[href], summary, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="tab"], [role="checkbox"], [role="switch"], [role="option"]',
    )
  ) {
    return true;
  }
  return false;
}

/** Options for {@link useSpaceDragPan}. */
export interface UseSpaceDragPanOptions {
  /** Set `false` to disable all listeners (e.g. on the mobile snap board). */
  enabled?: boolean;
}

/** Return value of {@link useSpaceDragPan}. */
export interface UseSpaceDragPanResult {
  /** Attach to the scroll container that should pan. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** `true` while Space is held (pan mode armed) — drives cursor styling. */
  isSpaceHeld: boolean;
  /** `true` while an active click-drag pan is in progress. */
  isPanning: boolean;
  /**
   * Stable predicate for {@link SpaceAwarePointerSensor}'s
   * `shouldSuppressActivation`. Returns `true` while pan mode is armed.
   */
  shouldSuppressDrag: () => boolean;
}

/**
 * Wires Space-held click-drag panning onto a scroll container.
 *
 * @param options - See {@link UseSpaceDragPanOptions}.
 * @returns A ref for the scroll container plus the pan-mode flags and the dnd
 *   suppression predicate. See {@link UseSpaceDragPanResult}.
 */
export function useSpaceDragPan({ enabled = true }: UseSpaceDragPanOptions = {}): UseSpaceDragPanResult {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isSpaceHeld, setIsSpaceHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  // Ref mirror of "Space held" so the dnd-kit sensor's static activator reads
  // the live value on each pointer-down without the sensor being re-created on
  // every state change.
  const spaceHeldRef = useRef(false);
  const shouldSuppressDrag = useCallback(() => spaceHeldRef.current, []);

  // Arm / disarm pan mode on Space keydown / keyup.
  useEffect(() => {
    if (!enabled) return;

    function disarm() {
      if (!spaceHeldRef.current) return;
      spaceHeldRef.current = false;
      setIsSpaceHeld(false);
      setIsPanning(false);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (e.repeat || spaceHeldRef.current) return; // autorepeat while held — act once
      if (isSpacePanBlocked(e.target)) return;
      // Suppress the browser's default page-down scroll so Space can drive
      // drag-pan instead.
      e.preventDefault();
      spaceHeldRef.current = true;
      setIsSpaceHeld(true);
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== 'Space' && e.key !== ' ') return;
      disarm();
    }

    // A window blur (tab-out, alt-tab) would otherwise leave Space "stuck" on,
    // since the keyup never arrives — reset defensively.
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', disarm);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', disarm);
    };
  }, [enabled]);

  // Click-drag panning on the scroll container while pan mode is armed.
  useEffect(() => {
    if (!enabled) return;
    const el = scrollRef.current;
    if (!el) return;

    let start: { x: number; y: number; left: number; top: number; pointerId: number } | null = null;

    function onPointerDown(e: PointerEvent) {
      if (!spaceHeldRef.current || e.button !== 0 || !el) return;
      start = {
        x: e.clientX,
        y: e.clientY,
        left: el.scrollLeft,
        top: el.scrollTop,
        pointerId: e.pointerId,
      };
      el.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      setIsPanning(true);
    }

    function onPointerMove(e: PointerEvent) {
      if (!start || e.pointerId !== start.pointerId || !el) return;
      el.scrollLeft = start.left - (e.clientX - start.x);
      el.scrollTop = start.top - (e.clientY - start.y);
    }

    function endPan(e: PointerEvent) {
      if (!start || e.pointerId !== start.pointerId) return;
      try {
        el?.releasePointerCapture?.(start.pointerId);
      } catch {
        // Capture may already be gone (element unmounting) — safe to ignore.
      }
      start = null;
      setIsPanning(false);
    }

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', endPan);
    el.addEventListener('pointercancel', endPan);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', endPan);
      el.removeEventListener('pointercancel', endPan);
    };
  }, [enabled]);

  return { scrollRef, isSpaceHeld, isPanning, shouldSuppressDrag };
}
