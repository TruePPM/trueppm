import type { Task } from '@/types';

export interface WbsNode {
  task: Task;
  depth: number;
  children: WbsNode[];
  /** wbs label of parent, e.g. "1.2" — empty string for root nodes */
  parentWbs: string;
}

/**
 * Derive a tree structure from a flat Task array.
 *
 * Uses parentId to build parent→children relationships, then sorts siblings
 * by their wbs path so the tree matches the WBS numbering. O(n log n).
 */
export function buildWbsTree(tasks: Task[]): WbsNode[] {
  const byId = new Map<string, Task>(tasks.map((t) => [t.id, t]));

  const childrenOf = new Map<string | null, Task[]>();
  for (const task of tasks) {
    const parentKey = task.parentId ?? null;
    if (!childrenOf.has(parentKey)) {
      childrenOf.set(parentKey, []);
    }
    childrenOf.get(parentKey)!.push(task);
  }

  const wbsCompare = (a: Task, b: Task): number => {
    const aParts = (a.wbs || '0').split('.').map(Number);
    const bParts = (b.wbs || '0').split('.').map(Number);
    const len = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < len; i++) {
      const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };

  for (const siblings of childrenOf.values()) {
    siblings.sort(wbsCompare);
  }

  function buildNodes(parentId: string | null, depth: number): WbsNode[] {
    const children = childrenOf.get(parentId) ?? [];
    return children.map((task) => {
      const parent = task.parentId ? byId.get(task.parentId) : undefined;
      return {
        task,
        depth,
        parentWbs: parent?.wbs ?? '',
        children: buildNodes(task.id, depth + 1),
      };
    });
  }

  return buildNodes(null, 0);
}

/**
 * Flatten a tree into a display-ordered list, skipping collapsed subtrees.
 * Returns only visible nodes respecting expandedIds.
 */
export function flattenVisible(nodes: WbsNode[], expandedIds: Set<string>): WbsNode[] {
  const result: WbsNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children.length > 0 && expandedIds.has(node.task.id)) {
      result.push(...flattenVisible(node.children, expandedIds));
    }
  }
  return result;
}

/** Collect all node IDs in the tree (for expand-all). */
export function collectAllIds(nodes: WbsNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    ids.push(node.task.id);
    if (node.children.length > 0) {
      ids.push(...collectAllIds(node.children));
    }
  }
  return ids;
}
