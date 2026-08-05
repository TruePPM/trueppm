import { useSyncExternalStore } from 'react';

/**
 * Below 900px the Start sheet (#2728) becomes a full-screen surface with the same
 * field order and the way-in cards stacked 2×2 instead of one row of three. 900px
 * is bespoke to this component — it does not line up with `useBreakpoint`'s
 * toolbar-driven `md`/`lg` tiers (768/1024), so this is its own tiny query rather
 * than a misapplied reuse of that hook. Follows the same SSR-safe
 * `useSyncExternalStore` pattern as `useBreakpoint`/`usePrefersReducedMotion`.
 */
const COMPACT_QUERY = '(max-width: 899px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(COMPACT_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(COMPACT_QUERY).matches;
}

function getServerSnapshot(): boolean {
  // Default to the reference (desktop, one row of three) layout.
  return false;
}

export function useStartSheetCompact(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
