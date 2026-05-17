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
 * Compute the chain reachable from `hoveredId`, coalesced through rAF so that
 * rapid hover changes don't compute the chain more than once per frame.
 *
 * Returns the empty chain when `hoveredId` is null.
 */
export function useDependencyHover(
  hoveredId: string | null,
  links: TaskLink[],
): DependencyChain {
  const adjacency = useMemo(() => buildAdjacency(links), [links]);

  // Coalesce hover transitions through rAF — at most one effective hoveredId
  // change per animation frame, even if the row layer raises many in quick
  // succession during a mouse sweep.
  const [coalesced, setCoalesced] = useState<string | null>(null);
  const pendingRafRef = useRef<number | null>(null);
  const nextValueRef = useRef<string | null>(null);

  useEffect(() => {
    nextValueRef.current = hoveredId;
    if (pendingRafRef.current !== null) return;
    pendingRafRef.current = requestAnimationFrame(() => {
      pendingRafRef.current = null;
      setCoalesced(nextValueRef.current);
    });
    return () => {
      if (pendingRafRef.current !== null) {
        cancelAnimationFrame(pendingRafRef.current);
        pendingRafRef.current = null;
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
