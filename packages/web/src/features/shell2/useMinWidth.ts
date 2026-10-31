import { useSyncExternalStore } from 'react';

/**
 * True when the viewport is at least `px` wide. The shell's own breakpoint
 * (`useBreakpoint`) stops at `lg` = 1024, but the rail expands at 1280: between
 * 1024 and 1279 it is the 64px icon rail with the Work flyout (shell spec).
 */
export function useMinWidth(px: number): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined') return () => {};
      const mq = window.matchMedia(`(min-width: ${px}px)`);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () =>
      typeof window === 'undefined' ? true : window.matchMedia(`(min-width: ${px}px)`).matches,
    () => true,
  );
}
