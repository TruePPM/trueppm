import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';

/**
 * Horizontal scroll region for the shell view/program nav (ADR-0134). The grouped
 * view-tab strip (~950–975px) can exceed the available width below ~1440px once it
 * shares one row with the pinned health cluster + right chrome. Rather than clip it
 * silently (the pre-v2 latent bug) or degrade tab labels to icon-only (rejected by
 * the VoC panel — Jordan/Alex/Marcus 🔴 + WCAG 1.1.1), the strip scrolls
 * independently while the right cluster stays pinned.
 *
 * Behavior contract (ADR-0134 acceptance criteria):
 * - Scroll affordances (edge fade + chevron) appear ONLY when the strip overflows in
 *   that direction; a strip that fits is static with no affordance.
 * - The active tab (`[aria-current="page"]`) is auto-scrolled into view on route change.
 * - Tab links stay keyboard-reachable: Tab moves between them and the browser scrolls
 *   the focused link into view. A `<nav>` of links is NOT a tablist, so sequential Tab
 *   focus — not arrow-key roving tabindex — is the correct WCAG pattern here; the
 *   chevrons are a pointer-only convenience (`tabIndex={-1}`), never the sole path.
 */
export function ShellNavScroller({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const [edges, setEdges] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
  }, []);

  // Recompute overflow on mount, viewport resize, and content (tab set) changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [recompute]);

  // Auto-scroll the active tab into view whenever the route changes (VoC: Schedule /
  // Backlog must be reachable, never stranded off-screen after navigation).
  useEffect(() => {
    const active = scrollRef.current?.querySelector('[aria-current="page"]');
    active?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
    recompute();
  }, [pathname, recompute]);

  const nudge = (dir: -1 | 1) =>
    scrollRef.current?.scrollBy?.({ left: dir * 240, behavior: 'smooth' });

  return (
    <div className="relative flex min-w-0 flex-1 items-stretch self-stretch">
      {edges.left && (
        <>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-chrome-surface to-transparent"
          />
          <button
            type="button"
            aria-label="Scroll views left"
            tabIndex={-1}
            onClick={() => nudge(-1)}
            className="absolute inset-y-0 left-0 z-20 flex w-6 items-center justify-center text-chrome-text-secondary hover:text-chrome-text-primary"
          >
            <Chevron dir="left" />
          </button>
        </>
      )}

      <div
        ref={scrollRef}
        onScroll={recompute}
        className="flex min-w-0 items-stretch overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>

      {edges.right && (
        <>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-chrome-surface to-transparent"
          />
          <button
            type="button"
            aria-label="Scroll views right"
            tabIndex={-1}
            onClick={() => nudge(1)}
            className="absolute inset-y-0 right-0 z-20 flex w-6 items-center justify-center text-chrome-text-secondary hover:text-chrome-text-primary"
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
      width="14"
      height="14"
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
