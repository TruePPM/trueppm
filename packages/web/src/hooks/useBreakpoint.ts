import { useSyncExternalStore } from 'react';

/**
 * Viewport tier used by toolbar responsive rules (issue #568, rules 110–112).
 *
 * `lg` = ≥ 1024 px (full labels)
 * `md` = 768–1023 px (icon-only secondary controls)
 * `sm` = < 768 px (secondary controls collapse into `ToolbarOverflowMenu`)
 *
 * Mirrors the `lg:` / `md:` Tailwind breakpoints in `tailwind.config.ts`.
 * Anything narrower than `md` (mobile) is reported as `sm` regardless of the
 * `sm:`/`xs:` Tailwind breakpoints — the toolbar collapse contract only cares
 * about the three tiers above. Use `usePrefersReducedMotion` as a template;
 * this hook follows the same `useSyncExternalStore` SSR-safe pattern.
 */
export type Breakpoint = 'sm' | 'md' | 'lg';

const MD_QUERY = '(min-width: 768px)';
const LG_QUERY = '(min-width: 1024px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const md = window.matchMedia(MD_QUERY);
  const lg = window.matchMedia(LG_QUERY);
  md.addEventListener('change', onChange);
  lg.addEventListener('change', onChange);
  return () => {
    md.removeEventListener('change', onChange);
    lg.removeEventListener('change', onChange);
  };
}

function getSnapshot(): Breakpoint {
  if (typeof window === 'undefined' || !window.matchMedia) return 'lg';
  if (window.matchMedia(LG_QUERY).matches) return 'lg';
  if (window.matchMedia(MD_QUERY).matches) return 'md';
  return 'sm';
}

function getServerSnapshot(): Breakpoint {
  // Default to the reference layout. SSR hydration on a narrower client
  // re-runs the snapshot after mount via the subscribe path.
  return 'lg';
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
