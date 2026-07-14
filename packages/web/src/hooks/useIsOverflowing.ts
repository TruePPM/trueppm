import { useEffect, useState, type RefObject } from 'react';

/**
 * True when the referenced element's content is clipped horizontally —
 * `scrollWidth > clientWidth`, i.e. a `truncate`/`text-ellipsis` element whose
 * text does not fit on one line (#1947).
 *
 * Re-measured via `ResizeObserver` so a column resize, density change, or font
 * load that changes the fit flips the result. SSR / JSDOM without
 * `ResizeObserver` resolves to the initial measurement (or `false` when the ref
 * is unmounted), never throwing.
 *
 * @param ref Element whose overflow to observe (attach to the clamped node).
 * @returns Whether the element currently overflows its inline box.
 */
export function useIsOverflowing(ref: RefObject<HTMLElement | null>): boolean {
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth);
    measure();

    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return overflowing;
}
