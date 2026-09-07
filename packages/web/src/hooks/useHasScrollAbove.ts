import { useEffect, useState } from 'react';

/**
 * True when the referenced scroll container has content above the current
 * scroll position — `scrollTop > 0`.
 *
 * The third member of the edge-fade probe family (`useHasScrollRight`,
 * `useHasScrollBelow`), and the one web-rule 290 clause (d) actually requires:
 * a one-sided fade is only honest for a scroller that always starts from a fixed
 * origin. The rail's view list is not that — Tab moves its scroll offset onto a
 * row deep in the list, so the top edge can carry hidden content as readily as
 * the bottom, and a bottom-only fade then states that everything above the fold
 * is everything there is.
 *
 * Re-measured on scroll and via `ResizeObserver` on the container and its direct
 * children, so a viewport resize or a band expanding/collapsing flips the result.
 * SSR / JSDOM without `ResizeObserver` resolves to the initial measurement (or
 * `false` when the container is unmounted) and never throws.
 *
 * @param el Scroll container whose vertical overflow to observe, or `null`
 *   before it mounts.
 * @returns Whether content sits above the current scroll position.
 */
export function useHasScrollAbove(el: HTMLElement | null): boolean {
  const [hasAbove, setHasAbove] = useState(false);

  useEffect(() => {
    if (!el) return;

    // 1px slack absorbs sub-pixel rounding at the exact top.
    const measure = () => setHasAbove(el.scrollTop > 1);
    measure();

    el.addEventListener('scroll', measure, { passive: true });
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
      // Observe the children too — a content-height change (a band expanding,
      // the personal tier disclosing) can clamp `scrollTop` without resizing the
      // container itself (rule 290 pattern).
      for (const child of Array.from(el.children)) ro.observe(child);
    }
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, [el]);

  return hasAbove;
}
