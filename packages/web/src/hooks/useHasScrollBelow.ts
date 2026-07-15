import { useEffect, useState, type RefObject } from 'react';

/**
 * True when the referenced scroll container has content below the current
 * scroll position — `scrollTop + clientHeight < scrollHeight`.
 *
 * Drives a bottom edge-fade affordance so vertical overflow is discoverable on
 * platforms with auto-hiding scrollbars (macOS, touch), where a card clipped
 * flush at the fold otherwise reads as truncation, not overflow (#1962). This
 * is the vertical analog of the horizontal edge-fade probe in `ShellNavScroller`
 * (web-rule 174).
 *
 * Re-measured on scroll and via `ResizeObserver` on the container and its direct
 * children, so a viewport resize, a card added to a column, a panel expanding,
 * or a board zoom change flips the result. SSR / JSDOM without `ResizeObserver`
 * resolves to the initial measurement (or `false` when the ref is unmounted) and
 * never throws.
 *
 * @param ref Scroll container whose vertical overflow to observe.
 * @returns Whether more content sits below the current scroll position.
 */
export function useHasScrollBelow(ref: RefObject<HTMLElement | null>): boolean {
  const [hasBelow, setHasBelow] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // 1px slack absorbs sub-pixel rounding at the exact bottom.
    const measure = () => setHasBelow(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    measure();

    el.addEventListener('scroll', measure, { passive: true });
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
      // Observe the children too — content-height changes (a taller lane, an
      // expanded panel) don't resize the container itself (rule 174 pattern).
      for (const child of Array.from(el.children)) ro.observe(child);
    }
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, [ref]);

  return hasBelow;
}
