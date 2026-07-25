import { useEffect, useState } from 'react';

/**
 * True when the referenced element's content is clipped horizontally —
 * `scrollWidth > clientWidth`, i.e. a `truncate`/`text-ellipsis` element whose
 * text does not fit on one line (#1947).
 *
 * Re-measured via `ResizeObserver` so a column resize, density change, or font
 * load that changes the fit flips the result. SSR / JSDOM without
 * `ResizeObserver` resolves to the initial measurement (or `false` when the
 * element is unmounted), never throwing.
 *
 * Takes the node rather than a `RefObject` so the measurement still happens
 * when the node mounts late — the clamped title only exists in the compact
 * card branch, so a runtime density switch mounts it several commits after
 * this hook first runs (web-rule 279, #2365).
 *
 * @param el Element whose overflow to observe (attach to the clamped node), or
 *   `null` before it mounts.
 * @returns Whether the element currently overflows its inline box.
 */
export function useIsOverflowing(el: HTMLElement | null): boolean {
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    if (!el) return;

    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth);
    measure();

    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);

  return overflowing;
}
