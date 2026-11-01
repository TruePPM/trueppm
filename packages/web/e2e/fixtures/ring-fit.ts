import type { Locator } from '@playwright/test';

/**
 * How far (px) a `ring-2 ring-offset-1` focus ring on any direct child of the
 * nearest horizontal scroller around `child` would extend past that scroller's
 * clip box. `overflow-x: auto` clips on BOTH axes, so a scroller with no
 * padding cuts the ring off — and jsdom has no layout to see it (#4775).
 * A result <= 0 means every child's ring fits.
 */
export async function scrollerRingOverflow(child: Locator, ringExtent = 3): Promise<number> {
  return child.evaluate((el, extent) => {
    let scroller = el.parentElement;
    while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowX)) {
      scroller = scroller.parentElement;
    }
    if (!scroller) throw new Error('no horizontal scroller around the element');
    const s = scroller.getBoundingClientRect();
    let worst = -Infinity;
    for (const c of Array.from(scroller.children)) {
      const b = c.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      worst = Math.max(
        worst,
        s.left - (b.left - extent),
        b.right + extent - s.right,
        s.top - (b.top - extent),
        b.bottom + extent - s.bottom,
      );
    }
    return worst;
  }, ringExtent);
}
