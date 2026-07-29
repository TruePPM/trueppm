/**
 * `StatusClusterScroller` — the shell bar's overflow rule (#2533, rule 290).
 *
 * JSDOM has no layout engine: every element measures 0, so the *geometry* of the
 * fix (breadcrumb width stable, trailing segment reachable at 1024) is asserted in
 * `e2e/unified-shell-bar.spec.ts` where a real engine exists. What is asserted
 * here is everything rule 290 makes a structural promise about — the overflow
 * classes, the min-width floor, the motion gate, both edge affordances appearing
 * only on the side that overflows, and the region never becoming a focus
 * dead-end. Overflow is simulated by stubbing the scroll metrics, which is the
 * only way to reach the edge-affordance branches without a layout engine.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { StatusClusterScroller } from './StatusClusterScroller';

/** Force the scroll metrics JSDOM cannot compute, then trigger a re-measure. */
function simulateOverflow(
  el: HTMLElement,
  { scrollWidth, clientWidth, scrollLeft }: Record<string, number>,
) {
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
  el.scrollLeft = scrollLeft;
  fireEvent.scroll(el);
}

/** Record the `scrollBy` options the nudge issues, with a typed capture (the
 *  DOM signature is overloaded, so a bare `vi.fn()` widens the call args to `any`). */
function captureScrollBy(el: HTMLElement): ScrollToOptions[] {
  const calls: ScrollToOptions[] = [];
  el.scrollBy = ((options?: ScrollToOptions | number) => {
    if (typeof options === 'object' && options !== null) calls.push(options);
  }) as HTMLElement['scrollBy'];
  return calls;
}

function renderScroller() {
  const view = render(
    <StatusClusterScroller>
      <button type="button">Health</button>
    </StatusClusterScroller>,
  );
  return { ...view, scroller: screen.getByTestId('shell-status-cluster') };
}

afterEach(() => vi.unstubAllGlobals());

describe('StatusClusterScroller (#2533, rule 290)', () => {
  it('carries the overflow rule with a min-width floor and no reserved scrollbar gutter', () => {
    const { scroller } = renderScroller();
    const wrapper = screen.getByTestId('shell-status-cluster-wrap');

    // The fix itself: the strip scrolls instead of pushing…
    expect(scroller.className).toContain('min-w-0');
    expect(scroller.className).toContain('overflow-x-auto');
    // …its segments keep their natural width inside the viewport (without this
    // they compress and the overflow never happens — the #2208 trap inverted)…
    expect(scroller.className).toContain('[&>*]:shrink-0');
    // …the scrollbar reserves nothing, so overflow appearing shifts no layout…
    expect(scroller.className).toContain('[scrollbar-width:none]');
    expect(scroller.className).toContain('[&::-webkit-scrollbar]:hidden');
    // …and the strip has a floor, so shrink pressure can never erase it before
    // the breadcrumb yields (rule 290b).
    expect(wrapper.className).toContain('md:min-w-[6rem]');
  });

  it('gates its motion (rule 70) — reduced motion still scrolls, just without easing', () => {
    const { scroller } = renderScroller();
    expect(scroller.className).toContain('scroll-smooth');
    expect(scroller.className).toContain('motion-reduce:scroll-auto');
  });

  it('is never a focus dead-end — no tabindex, inert, or aria-hidden on the region', () => {
    const { scroller } = renderScroller();
    // A scrolled-out segment stays reachable because it is still an ordinary
    // focusable control in document order. A `tabindex` here would mint a
    // redundant tab stop; axe's scrollable-region-focusable is satisfied by the
    // focusable children instead (rule 290f).
    expect(scroller).not.toHaveAttribute('tabindex');
    expect(scroller).not.toHaveAttribute('inert');
    expect(scroller).not.toHaveAttribute('aria-hidden');
    expect(screen.getByRole('button', { name: 'Health' })).toBeInTheDocument();
  });

  it('shows no edge affordance while the strip fits', () => {
    renderScroller();
    expect(screen.queryByTestId('shell-status-cluster-fade-left')).not.toBeInTheDocument();
    expect(screen.queryByTestId('shell-status-cluster-fade-right')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /scroll status/i })).not.toBeInTheDocument();
  });

  it('shows only the right affordance at the start of an overflowing strip', () => {
    const { scroller } = renderScroller();
    simulateOverflow(scroller, { scrollWidth: 600, clientWidth: 300, scrollLeft: 0 });

    expect(screen.getByTestId('shell-status-cluster-fade-right')).toBeInTheDocument();
    expect(screen.queryByTestId('shell-status-cluster-fade-left')).not.toBeInTheDocument();
    // The pointer-only path: a vertical-wheel mouse has no horizontal gesture and
    // there is no scrollbar to drag, so the nudge is the only pointer route to a
    // scrolled-out segment (rule 290e).
    expect(screen.getByRole('button', { name: 'Scroll status right' })).toBeInTheDocument();
  });

  it('shows only the left affordance at the end of an overflowing strip', () => {
    const { scroller } = renderScroller();
    simulateOverflow(scroller, { scrollWidth: 600, clientWidth: 300, scrollLeft: 300 });

    expect(screen.getByTestId('shell-status-cluster-fade-left')).toBeInTheDocument();
    expect(screen.queryByTestId('shell-status-cluster-fade-right')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll status left' })).toBeInTheDocument();
  });

  it('shows both affordances mid-scroll, and keeps the chevrons out of the tab order', () => {
    const { scroller } = renderScroller();
    simulateOverflow(scroller, { scrollWidth: 600, clientWidth: 300, scrollLeft: 120 });

    expect(screen.getByTestId('shell-status-cluster-fade-left')).toBeInTheDocument();
    expect(screen.getByTestId('shell-status-cluster-fade-right')).toBeInTheDocument();
    // Convenience only — the keyboard path is Tab through the segments.
    for (const name of ['Scroll status left', 'Scroll status right']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('tabindex', '-1');
    }
  });

  it('nudges the strip forward, smoothly, when the chevron is pressed', () => {
    const { scroller } = renderScroller();
    const calls = captureScrollBy(scroller);
    simulateOverflow(scroller, { scrollWidth: 600, clientWidth: 300, scrollLeft: 0 });

    fireEvent.click(screen.getByRole('button', { name: 'Scroll status right' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].behavior).toBe('smooth');
    // Direction matters too: the right chevron must move the strip forward.
    expect(calls[0].left ?? 0).toBeGreaterThan(0);
  });

  it('drops the nudge easing under prefers-reduced-motion, but still scrolls (rule 70)', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));

    const { scroller } = renderScroller();
    const calls = captureScrollBy(scroller);
    simulateOverflow(scroller, { scrollWidth: 600, clientWidth: 300, scrollLeft: 0 });

    fireEvent.click(screen.getByRole('button', { name: 'Scroll status right' }));
    // Functionality is never disabled, only motion: it still scrolls, instantly.
    expect(calls).toHaveLength(1);
    expect(calls[0].behavior).toBe('auto');
    expect(calls[0].left ?? 0).toBeGreaterThan(0);
  });
});
