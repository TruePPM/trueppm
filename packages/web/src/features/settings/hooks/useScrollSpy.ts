import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Resolve which section id is "active" given each section's distance from a
 * sentinel line near the top of the scroll viewport (ADR-0146).
 *
 * The active section is the LAST section whose top edge is at or above the
 * sentinel (i.e. the section the reader has scrolled into). If every section is
 * still below the sentinel (page scrolled to the very top), the first section is
 * active. Pure so it can be unit-tested without a DOM.
 *
 * @param tops      section id → top offset relative to the scroll line, in px
 *                  (negative = scrolled above the sentinel)
 * @param order     section ids in document order
 * @returns the active section id, or null when `order` is empty
 */
export function resolveActiveSection(
  tops: Record<string, number>,
  order: string[],
): string | null {
  if (order.length === 0) return null;
  let active = order[0];
  for (const id of order) {
    const top = tops[id];
    if (top == null) continue;
    // <= 0 means this section's top has crossed the sentinel going up.
    if (top <= 0) {
      active = id;
    } else {
      break;
    }
  }
  return active;
}

interface UseScrollSpyOptions {
  /** Section ids in document order. */
  sectionIds: string[];
  /** The scroll container element (the settings content panel). */
  scrollRef: RefObject<HTMLElement | null>;
  /**
   * Distance from the top of the scroll viewport that counts as "the line"
   * (px). A section is active once its top scrolls above this line.
   */
  offset?: number;
}

/**
 * Scroll-spy for the consolidated settings page.
 *
 * Tracks which `<section id>` the reader is currently in and exposes a
 * `scrollTo(id)` that smooth-scrolls to a section (instant under
 * `prefers-reduced-motion`) and moves focus to its heading for keyboard / SR
 * users. The shell stays mounted — no route change.
 */
export function useScrollSpy({ sectionIds, scrollRef, offset = 96 }: UseScrollSpyOptions) {
  const [activeId, setActiveId] = useState<string | null>(sectionIds[0] ?? null);
  // Suppress observer-driven updates briefly after a click so the clicked item
  // stays highlighted through the smooth-scroll animation instead of flickering
  // through intermediate sections.
  const clickLockRef = useRef<number | null>(null);

  const recompute = useCallback(() => {
    if (clickLockRef.current != null) return;
    const container = scrollRef.current;
    if (!container) return;
    const lineY = container.getBoundingClientRect().top + offset;
    const tops: Record<string, number> = {};
    for (const id of sectionIds) {
      const el = container.querySelector<HTMLElement>(`[data-settings-section="${id}"]`);
      if (el) tops[id] = el.getBoundingClientRect().top - lineY;
    }
    let next = resolveActiveSection(tops, sectionIds);
    // Last-section guard (#2252): the final section is often shorter than
    // (viewport − offset), so its top can never scroll up to the sentinel line
    // and resolveActiveSection would freeze on the second-to-last section even
    // when the reader is looking straight at the last one. When the container is
    // scrolled to (within 2px of) its bottom, force the last section active so
    // the final rail item highlights.
    const atBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <= 2;
    if (atBottom && sectionIds.length > 0) {
      next = sectionIds[sectionIds.length - 1];
    }
    if (next) setActiveId(next);
  }, [sectionIds, scrollRef, offset]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    recompute();
    container.addEventListener('scroll', recompute, { passive: true });
    window.addEventListener('resize', recompute);
    return () => {
      container.removeEventListener('scroll', recompute);
      window.removeEventListener('resize', recompute);
    };
  }, [recompute, scrollRef]);

  const scrollTo = useCallback(
    (id: string) => {
      const container = scrollRef.current;
      if (!container) return;
      const el = container.querySelector<HTMLElement>(`[data-settings-section="${id}"]`);
      if (!el) return;

      // Highlight the target immediately; lock the observer through the animation.
      setActiveId(id);
      if (clickLockRef.current != null) window.clearTimeout(clickLockRef.current);
      clickLockRef.current = window.setTimeout(() => {
        clickLockRef.current = null;
        recompute();
      }, 600);

      const reduceMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });

      // Move focus into the section heading so keyboard / SR users land in it.
      const heading = el.querySelector<HTMLElement>('[data-settings-section-heading]');
      heading?.focus({ preventScroll: true });
    },
    [scrollRef, recompute],
  );

  // Clear any pending click-lock timer on unmount.
  useEffect(
    () => () => {
      if (clickLockRef.current != null) window.clearTimeout(clickLockRef.current);
    },
    [],
  );

  return { activeId, scrollTo };
}
