import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskLink } from '@/types';

/**
 * Hover-driven chain highlight (#475). Resolves the predecessor and successor
 * chain reachable from the currently hovered task, coalesced through
 * requestAnimationFrame so rapid mousemove-driven hover changes never run BFS
 * more than once per frame.
 *
 * Two compute steps:
 *   1. Adjacency map (memoized on `links`): O(V + E) Map<taskId, string[]>.
 *   2. BFS from `hoveredId` (rAF-coalesced): O(V + E) worst case; sub-millisecond
 *      at 500 tasks per architect Q6.
 *
 * Hovered id comes from React row callbacks (TaskListRow.onMouseEnter /
 * onFocus → ScheduleView state); the engine doesn't drive hover itself. The
 * resulting chain is fed back to the canvas via `engine.setHoverChain` and to
 * the task-list panel via `focusChainIds`.
 */

export interface DependencyChain {
  /** Hovered task id (the chain "origin"). null when nothing is hovered. */
  hoveredId: string | null;
  /** All task ids transitively upstream from the hovered task (predecessors). */
  predecessors: ReadonlySet<string>;
  /** All task ids transitively downstream (successors). */
  successors: ReadonlySet<string>;
  /** Union of predecessors + hoveredId + successors. Used as the focusChainIds
   *  prop on TaskListPanel — non-members get dimmed. */
  chain: ReadonlySet<string>;
}

const EMPTY_CHAIN: DependencyChain = {
  hoveredId: null,
  predecessors: new Set(),
  successors: new Set(),
  chain: new Set(),
};

interface AdjacencyMaps {
  predsByTask: Map<string, string[]>;
  succsByTask: Map<string, string[]>;
}

function buildAdjacency(links: TaskLink[]): AdjacencyMaps {
  const predsByTask = new Map<string, string[]>();
  const succsByTask = new Map<string, string[]>();
  for (const link of links) {
    const succList = succsByTask.get(link.sourceId);
    if (succList) succList.push(link.targetId);
    else succsByTask.set(link.sourceId, [link.targetId]);

    const predList = predsByTask.get(link.targetId);
    if (predList) predList.push(link.sourceId);
    else predsByTask.set(link.targetId, [link.sourceId]);
  }
  return { predsByTask, succsByTask };
}

function bfs(
  startId: string,
  adjacency: Map<string, string[]>,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [startId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const neighbours = adjacency.get(id);
    if (!neighbours) continue;
    for (const n of neighbours) {
      if (visited.has(n)) continue;
      visited.add(n);
      queue.push(n);
    }
  }
  return visited;
}

/**
 * Settle delay before a hover transition activates the chain (ms). Mouse
 * sweeps across rows shouldn't fire the chain on every passing row — only
 * once the cursor pauses for this long. Set to feel snappy on intent without
 * triggering on incidental movement. Clearing (taskId → null) is immediate
 * so leaving the canvas drops the chain without lag.
 */
const HOVER_SETTLE_MS = 80;

/**
 * Compute the chain reachable from `hoveredId`, debounced with a small
 * settle delay so rapid mouse sweeps don't fire the chain on every row the
 * cursor crosses. Clearing the hover (taskId becomes null) is immediate.
 *
 * Returns the empty chain when `hoveredId` is null.
 */
export function useDependencyHover(
  hoveredId: string | null,
  links: TaskLink[],
): DependencyChain {
  const adjacency = useMemo(() => buildAdjacency(links), [links]);

  // Debounce hover activation; clear immediately.
  const [coalesced, setCoalesced] = useState<string | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pendingTimerRef.current !== null) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    if (hoveredId === null) {
      // Drop the chain right away — no settle delay on clear.
      setCoalesced(null);
      return;
    }
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      setCoalesced(hoveredId);
    }, HOVER_SETTLE_MS);
    return () => {
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
    };
  }, [hoveredId]);

  return useMemo(() => {
    if (!coalesced) return EMPTY_CHAIN;
    const predecessors = bfs(coalesced, adjacency.predsByTask);
    const successors = bfs(coalesced, adjacency.succsByTask);
    const chain = new Set<string>([coalesced]);
    for (const p of predecessors) chain.add(p);
    for (const s of successors) chain.add(s);
    return { hoveredId: coalesced, predecessors, successors, chain };
  }, [coalesced, adjacency]);
}
