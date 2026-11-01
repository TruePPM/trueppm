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
    const items = Array.from(scroller.children)
      .map((c) => c.getBoundingClientRect())
      .filter((b) => b.width > 0 || b.height > 0);
    if (items.length === 0) throw new Error('scroller has no rendered children');
    // Horizontally, children past the visible edge are scrolled out by design —
    // so measure the first and last child against the SCROLL extent, not the
    // viewport box. Vertically nothing scrolls, so every child must fit.
    const originLeft = s.left - scroller.scrollLeft;
    const first = items[0];
    const last = items[items.length - 1];
    let worst = Math.max(
      originLeft - (first.left - extent),
      last.right + extent - (originLeft + scroller.scrollWidth),
    );
    for (const b of items) {
      worst = Math.max(worst, s.top - (b.top - extent), b.bottom + extent - s.bottom);
    }
    return worst;
  }, ringExtent);
}
