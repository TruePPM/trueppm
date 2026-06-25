/**
 * useCardPopoverPosition unit tests (#784 coverage backfill).
 *
 * Pure viewport-clamp geometry — no network. The four branches each have a
 * visible consequence that must not regress: the default `bottom-start`
 * placement, the vertical flip when the popover would clip the viewport
 * bottom, the horizontal `end` flip when it would overflow the right edge,
 * and the "null until measured" guard (no anchor → no position, so callers
 * never paint a popover at (0,0)). Listener cleanup on unmount is asserted so
 * a detached anchor stops driving recomputes.
 *
 * jsdom gives no layout, so anchor geometry is injected via a per-element
 * getBoundingClientRect stub and the viewport via window.innerWidth/Height.
 * requestAnimationFrame is stubbed synchronous so a scroll-driven recompute
 * settles within the same tick — the rAF debounce path is still exercised
 * (schedule → measure), just without a real frame delay.
 */
import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useCardPopoverPosition, __testing } from './useCardPopoverPosition';

const { POPOVER_WIDTH, VIEWPORT_PAD, ANCHOR_GAP } = __testing;

/**
 * Build a detached element whose getBoundingClientRect returns a controlled
 * rect. `isConnected` is forced true so the measure path runs without
 * attaching to a real document (jsdom would report a zero rect anyway).
 */
function makeAnchor(rect: Partial<DOMRect>): HTMLElement {
  const el = document.createElement('div');
  const full: DOMRect = {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect;
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(full);
  Object.defineProperty(el, 'isConnected', { value: true, configurable: true });
  return el;
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

beforeEach(() => {
  setViewport(1200, 800);
  // Synchronous rAF: the hook's `schedule()` debounce calls rAF, so running
  // the callback immediately lets a scroll/resize recompute settle in-tick.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useCardPopoverPosition', () => {
  it('returns null until measured (no anchor)', () => {
    const { result } = renderHook(() => useCardPopoverPosition(null, 200));
    expect(result.current).toBeNull();
  });

  it('default placement: bottom-start, popover top-left under the anchor', () => {
    // Anchor comfortably inside a 1200×800 viewport; no flip on either axis.
    const anchor = makeAnchor({ top: 100, bottom: 124, left: 50, right: 150 });
    const { result } = renderHook(() => useCardPopoverPosition(anchor, 200));

    expect(result.current).toEqual({
      placement: 'bottom-start',
      // top = anchor.bottom + ANCHOR_GAP (well within the clamp ceiling)
      top: 124 + ANCHOR_GAP,
      // left = anchor.left (no right-edge overflow)
      left: 50,
    });
  });

  it('flips vertically (top-start) when the popover would clip the viewport bottom', () => {
    // Anchor near the bottom: bottom+gap+height+pad overflows vh, and there is
    // room above (top - gap - height >= pad), so flipUp triggers.
    const anchor = makeAnchor({ top: 700, bottom: 780, left: 50, right: 150 });
    const { result } = renderHook(() => useCardPopoverPosition(anchor, 200));

    expect(result.current).toEqual({
      placement: 'top-start',
      // top = anchor.top - ANCHOR_GAP - popoverHeight, clamped to >= VIEWPORT_PAD
      top: 700 - ANCHOR_GAP - 200,
      left: 50,
    });
  });

  it('flips horizontally (bottom-end) when the popover would overflow the right edge', () => {
    // Anchor near the right edge: left + POPOVER_WIDTH + pad overflows vw.
    const anchor = makeAnchor({ top: 100, bottom: 124, left: 1000, right: 1100 });
    const { result } = renderHook(() => useCardPopoverPosition(anchor, 200));

    expect(result.current).toEqual({
      placement: 'bottom-end',
      top: 124 + ANCHOR_GAP,
      // rawLeft = anchor.right - POPOVER_WIDTH, then clamped within the viewport
      left: 1100 - POPOVER_WIDTH,
    });
  });

  it('flips on both axes (top-end) for a bottom-right anchor', () => {
    const anchor = makeAnchor({ top: 700, bottom: 780, left: 1000, right: 1100 });
    const { result } = renderHook(() => useCardPopoverPosition(anchor, 200));

    expect(result.current).toMatchObject({
      placement: 'top-end',
      top: 700 - ANCHOR_GAP - 200,
      left: 1100 - POPOVER_WIDTH,
    });
  });

  it('clamps left to VIEWPORT_PAD when the anchor sits past the left edge', () => {
    const anchor = makeAnchor({ top: 100, bottom: 124, left: -50, right: 50 });
    const { result } = renderHook(() => useCardPopoverPosition(anchor, 200));

    // rawLeft = -50 → Math.max(VIEWPORT_PAD, …) floors it at the pad.
    expect(result.current?.left).toBe(VIEWPORT_PAD);
  });

  it('recomputes on scroll when the anchor moves into the flip zone', () => {
    const anchor = makeAnchor({ top: 100, bottom: 124, left: 50, right: 150 });
    const { result } = renderHook(() => useCardPopoverPosition(anchor, 200));
    expect(result.current?.placement).toBe('bottom-start');

    // Anchor scrolls down toward the viewport bottom; next measure must flip.
    (anchor.getBoundingClientRect as ReturnType<typeof vi.fn>).mockReturnValue({
      top: 700,
      bottom: 780,
      left: 50,
      right: 150,
      width: 100,
      height: 80,
      x: 50,
      y: 700,
      toJSON: () => ({}),
    } as DOMRect);

    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });

    expect(result.current?.placement).toBe('top-start');
    expect(result.current?.top).toBe(700 - ANCHOR_GAP - 200);
  });

  it('removes its scroll/resize listeners on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const anchor = makeAnchor({ top: 100, bottom: 124, left: 50, right: 150 });
    const { unmount } = renderHook(() => useCardPopoverPosition(anchor, 200));

    unmount();

    const removed = removeSpy.mock.calls.map((c) => c[0]);
    expect(removed).toContain('resize');
    expect(removed).toContain('scroll');

    // After unmount a stray scroll must not throw (listeners are gone).
    expect(() => window.dispatchEvent(new Event('scroll'))).not.toThrow();
  });

  it('resets to null when the anchor becomes null', () => {
    const anchor = makeAnchor({ top: 100, bottom: 124, left: 50, right: 150 });
    const { result, rerender } = renderHook(
      ({ a }: { a: HTMLElement | null }) => useCardPopoverPosition(a, 200),
      { initialProps: { a: anchor as HTMLElement | null } },
    );
    expect(result.current).not.toBeNull();

    rerender({ a: null });
    expect(result.current).toBeNull();
  });
});
