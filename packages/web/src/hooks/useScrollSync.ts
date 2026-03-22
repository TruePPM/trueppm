import { useEffect, useRef, type RefObject } from 'react';
import type { IApi } from '@svar-ui/gantt-store';

/**
 * Syncs vertical scroll between the task list panel (a plain DOM div) and SVAR's
 * Gantt timeline (controlled via its IApi).
 *
 * SVAR exposes:
 *   api.on("scroll-chart", ({ scrollTop }) => ...) — fires on timeline scroll
 *   api.exec("scroll-chart", { scrollTop })         — programmatically scrolls timeline
 *
 * An isSyncing guard prevents infinite feedback loops between the two scroll sources.
 */
export function useScrollSync(
  taskListRef: RefObject<HTMLDivElement | null>,
  ganttApiRef: RefObject<IApi | null>,
) {
  const isSyncing = useRef(false);

  // Task list → timeline
  useEffect(() => {
    const el = taskListRef.current;
    if (!el) return;

    const handleScroll = () => {
      if (isSyncing.current) return;
      const api = ganttApiRef.current;
      if (!api) return;
      isSyncing.current = true;
      // SVAR scroll-chart payload uses { top } not { scrollTop }
      void api.exec('scroll-chart', { top: el.scrollTop });
      isSyncing.current = false;
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [taskListRef, ganttApiRef]);

  // Timeline → task list
  useEffect(() => {
    const api = ganttApiRef.current;
    if (!api) return;

    // SVAR fires scroll-chart with { left?, top? } — we only care about vertical (top)
    api.on('scroll-chart', ({ top }: { left?: number; top?: number }) => {
      if (isSyncing.current || top === undefined) return;
      const el = taskListRef.current;
      if (!el) return;
      isSyncing.current = true;
      el.scrollTop = top;
      isSyncing.current = false;
    });
  }, [taskListRef, ganttApiRef]);
}
