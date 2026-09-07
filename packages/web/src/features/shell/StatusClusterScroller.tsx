import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useElementRef } from '@/hooks/useElementRef';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/** How far one chevron press nudges the strip — roughly one status segment. */
const NUDGE_PX = 140;

/**
 * Horizontal scroll region for the shell bar's **status cluster** (issue #2533).
 *
 * The bar's right side used to be one flat `shrink-0` row with no overflow rule:
 * it did not wrap and it did not scroll, so every segment added to the health
 * cluster pushed the location switcher and, past ~1024px, shoved the account chip
 * off the right edge. The #2483 design handoff (§5.1) measured five segments at
 * ~470px against a 640px budget at 1280 — the bar was already inside its own
 * budget, so the first surface to add a sixth broke it silently. This component is
 * the rule that was missing: the status half scrolls, everything else stays put.
 *
 * ## Behaviour contract
 *
 * - **Zero-layout overflow.** The scrollbar is suppressed (`scrollbar-width: none`
 *   + the WebKit pseudo-element), so overflow appearing never reserves a gutter
 *   and never shifts the bar. Discoverability is carried by the affordances below
 *   instead of by a scrollbar.
 * - **Both edges are signalled.** An edge fade renders only on a side that
 *   actually has content beyond it. A right-only fade is wrong here (unlike the
 *   board's, `useHasScrollRight`): Tab-to-focus can leave this strip scrolled to
 *   an arbitrary offset, so content hides to the *left* just as readily.
 * - **A pointer-only path exists, and it is scoped to the pointer that needs it.**
 *   Chevron nudges are the mouse user's way to scroll: a vertical-wheel mouse has
 *   no horizontal gesture, and with the scrollbar hidden there is nothing to drag.
 *   They are `tabIndex={-1}` because they are a convenience — the keyboard path is
 *   Tab, which every segment already answers — and they render only under
 *   `pointer: fine`, because a touch pointer swipes and a 20px overlay on a phone
 *   is both under the touch floor and a mis-hit on the chip beneath it (#3505).
 * - **Keyboard reachability is structural.** Segments stay ordinary focusable
 *   controls in document order; the browser scrolls a focused one into view. The
 *   region takes no `tabindex` of its own (that would mint a redundant tab stop,
 *   and axe's `scrollable-region-focusable` is satisfied by focusable children) —
 *   which does mean **every child must be focusable**.
 * - **Motion is gated** (rule 70): the smooth scroll and the smooth nudge both
 *   fall back to an instant jump under `prefers-reduced-motion`. The scrolling
 *   itself never stops — only its easing.
 * - **Overlays must escape.** `overflow-x: auto` establishes a clipping context on
 *   *both* axes, and `z-index` does not defeat it. Only children whose popovers
 *   portal to `document.body` or are `position: fixed` may live here. The bar's
 *   in-flow `absolute` panels (`QuickLogTime`, `CreateMenu`) deliberately stay
 *   outside, in the pinned group.
 * - **Focus rings are not sheared.** The symmetric `p-* -m-*` pair gives the
 *   clipping box headroom for the children's outset `focus:ring-*` shadows while
 *   leaving the painted position of the content exactly where it was.
 */
export function StatusClusterScroller({ children }: { children: ReactNode }) {
  const { el, setEl } = useElementRef<HTMLDivElement>();
  const reducedMotion = usePrefersReducedMotion();
  const [edges, setEdges] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });

  // 1px slack on both comparisons absorbs sub-pixel rounding at the exact edges.
  const recompute = useCallback(() => {
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
  }, [el]);

  // The node is state (rule 279), so this re-runs the moment the container
  // mounts — the bar's segments appear as their queries resolve, which is exactly
  // the post-first-commit case a `useRef`-based effect misses. Children are
  // observed too: a segment widening (a forecast date arriving) does not resize
  // the container, so observing only the container would miss it.
  useEffect(() => {
    if (!el) return undefined;
    recompute();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [el, recompute]);

  const nudge = (dir: -1 | 1) =>
    el?.scrollBy?.({ left: dir * NUDGE_PX, behavior: reducedMotion ? 'auto' : 'smooth' });

  return (
    // `min-w-0` lets the strip be squeezed (that is what makes it scroll rather
    // than push); the `md:min-w-*` floor stops the squeeze short of erasing it —
    // without a floor the strip is driven to zero width before the breadcrumb
    // gives up a single pixel, and the health chip vanishes with no scroll
    // affordance because there is nothing left to scroll inside. Past the floor
    // the breadcrumb truncates, which is the correct order of sacrifice.
    //
    // **Below md the floor is structural, not a utility, and adding one there is
    // dead CSS** (#3505). Since #3505 the phone bar's right region can be squeezed
    // (it was `shrink-0` before, so this strip was never under pressure on a
    // phone), which reads like it now needs its own sub-md floor. It does not: the
    // region deliberately keeps its automatic minimum size — see `TopBar`, where
    // *not* writing `min-w-0` on the region is what keeps the pinned chrome from
    // being squeezed off the right edge — and that minimum is computed from the
    // region's min-content, which *includes this strip's own min-content
    // contribution*. The strip therefore bottoms out at roughly one health chip
    // whatever the viewport does. Measured at 375 / 320 / 280px: the wrapper reads
    // 92 / 80.83 / 80.83px with `min-w-0` and byte-identical numbers with a
    // `min-w-8` floor added, because 32px is never reached. A floor written here
    // would document a guarantee that some other box is already making — and would
    // start binding, wrongly, the day the region ever gains `min-w-0`.
    // `[&:has(>div:empty)]:hidden` removes the wrapper — and therefore its gap —
    // on a route where every status child self-gates to null.
    <div
      className="relative flex min-w-0 items-center md:min-w-[6rem] [&:has(>div:empty)]:hidden"
      data-testid="shell-status-cluster-wrap"
    >
      <div
        ref={setEl}
        onScroll={recompute}
        data-testid="shell-status-cluster"
        className="flex min-w-0 items-center gap-1.5 overflow-x-auto overscroll-x-contain
          scroll-smooth motion-reduce:scroll-auto
          px-1 -mx-1 py-1.5 -my-1.5
          [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 md:gap-3"
      >
        {children}
      </div>

      {/* Edge affordances — decorative and pointer-transparent; the fade is never
          the only path to a scrolled-out segment (Tab always is). Rendered only
          while that side actually overflows, and overlaid rather than in-flow, so
          they cost no layout in either state.

          The **fades render on every pointer type; the chevrons only on a fine
          one** (#3505). The chevrons answer a question only a mouse has: a
          vertical-wheel mouse cannot scroll horizontally and, with the scrollbar
          hidden, has nothing to drag. A touch pointer swipes. Since #3505 the
          strip can also be squeezed on a phone, where a 20px chevron overlaying
          the last fifth of a 90px health chip is both under the 44px touch floor
          (rule 5/247) and a mis-hit waiting to happen — a tap meant for the chip
          nudging the strip instead. The fade stays either way, so the "there is
          more here" signal is not what is being gated. */}
      {edges.left && (
        <>
          <span
            aria-hidden="true"
            data-testid="shell-status-cluster-fade-left"
            className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-chrome-surface to-transparent"
          />
          <button
            type="button"
            tabIndex={-1}
            aria-label="Scroll status left"
            onClick={() => nudge(-1)}
            className="absolute inset-y-0 left-0 z-20 hidden w-5 items-center justify-center text-chrome-text-secondary hover:text-chrome-text-primary [@media(pointer:fine)]:flex"
          >
            <Chevron dir="left" />
          </button>
        </>
      )}

      {edges.right && (
        <>
          <span
            aria-hidden="true"
            data-testid="shell-status-cluster-fade-right"
            className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-chrome-surface to-transparent"
          />
          <button
            type="button"
            tabIndex={-1}
            aria-label="Scroll status right"
            onClick={() => nudge(1)}
            className="absolute inset-y-0 right-0 z-20 hidden w-5 items-center justify-center text-chrome-text-secondary hover:text-chrome-text-primary [@media(pointer:fine)]:flex"
          >
            <Chevron dir="right" />
          </button>
        </>
      )}
    </div>
  );
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path
        d={dir === 'left' ? 'M10 3 5 8l5 5' : 'M6 3l5 5-5 5'}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
