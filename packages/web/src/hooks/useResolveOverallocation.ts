/**
 * useResolveOverallocation — manages the open/close state of the
 * ResourceOverallocationDrawer and tracks which cell triggered it.
 *
 * Returns:
 *   - target: the OverallocationTarget currently shown in the drawer (or null)
 *   - isOpen: whether the drawer is visible
 *   - openDrawer: call when an overallocated cell is activated
 *   - closeDrawer: call when the drawer is dismissed
 *   - ariaMessage: a human-readable string for aria-live announcement on open
 */

import { useState, useCallback } from 'react';
import { capacityHours } from '@/features/resource/resourceUtils';
import type { OverallocationTarget } from '@/features/resource/ResourceOverallocationDrawer';

interface UseResolveOverallocationReturn {
  target: OverallocationTarget | null;
  isOpen: boolean;
  openDrawer: (t: OverallocationTarget) => void;
  closeDrawer: () => void;
  ariaMessage: string;
}

export function useResolveOverallocation(): UseResolveOverallocationReturn {
  const [target, setTarget] = useState<OverallocationTarget | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [ariaMessage, setAriaMessage] = useState('');

  const openDrawer = useCallback((t: OverallocationTarget) => {
    const capacity = capacityHours(t.hoursPerDay, t.maxUnits);
    // load% is server-owned (#989); capacity stays local only for the over-hours math.
    const pct = Math.round(t.entry.load_pct);
    const overHours = Math.max(0, t.entry.hours - capacity).toFixed(1);
    setAriaMessage(
      `Overallocation: ${t.resourceName} is at ${pct}% on ${t.iso} — ${overHours}h over capacity. Drawer open.`,
    );
    setTarget(t);
    setIsOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setIsOpen(false);
    // Keep target mounted during close animation (200ms), then clear
    setTimeout(() => setTarget(null), 250);
  }, []);

  return { target, isOpen, openDrawer, closeDrawer, ariaMessage };
}
