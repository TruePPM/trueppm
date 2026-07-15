import { useEffect, useState, type RefObject } from 'react';

/**
 * True when the referenced scroll container has content to the right of the
 * current scroll position — `scrollLeft + clientWidth < scrollWidth`.
 *
 * Drives a right edge-fade affordance so horizontal overflow is discoverable on
 * platforms with auto-hiding scrollbars (macOS, touch), where the rightmost
 * board column clipped flush at the viewport edge otherwise reads as truncation,
 * not overflow (#1972). This is the horizontal analog of `useHasScrollBelow`
 * (the board's vertical edge-fade, #1962) and of the `ShellNavScroller` probe
 * (web-rule 174).
 *
 * Re-measured on scroll and via `ResizeObserver` on the container and its direct
 * children, so a viewport resize, a card added to a column, a panel expanding, a
 * column collapse, or a board zoom change flips the result. SSR / JSDOM without
 * `ResizeObserver` resolves to the initial measurement (or `false` when the ref
 * is unmounted) and never throws.
 *
 * @param ref Scroll container whose horizontal overflow to observe.
 * @returns Whether more content sits to the right of the current scroll position.
 */
export function useHasScrollRight(ref: RefObject<HTMLElement | null>): boolean {
  const [hasRight, setHasRight] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // 1px slack absorbs sub-pixel rounding at the exact right edge.
    const measure = () => setHasRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    measure();

    el.addEventListener('scroll', measure, { passive: true });
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
      // Observe the children too — content-width changes (a column expanded from
      // a stub, a zoom change) don't resize the container itself (rule 174 pattern).
      for (const child of Array.from(el.children)) ro.observe(child);
    }
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, [ref]);

  return hasRight;
}
