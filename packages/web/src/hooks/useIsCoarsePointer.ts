import { useEffect, useState } from 'react';

function coarsePointerNow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * True on touch-primary / coarse-pointer devices (mobile web). Drives the
 * ADR-0151 rule that the inline "Recalc %?" prompt is suppressed on mobile —
 * `confirm` silently behaves as `keep` there, never a modal, never a block.
 * SSR or a JSDOM environment without `matchMedia` resolves to `false` (desktop).
 */
export function useIsCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState<boolean>(coarsePointerNow);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(pointer: coarse)');
    const onChange = () => setCoarse(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  return coarse;
}
