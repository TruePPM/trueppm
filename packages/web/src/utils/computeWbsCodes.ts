import type { Task } from '@/types';

/**
 * Derive WBS display codes from tree position.
 *
 * Returns a Map<taskId, wbsCode> computed solely from parentId and sibling
 * ordering — not from the stored wbs_path. Root tasks receive codes "1", "2",
 * …; their children receive "1.1", "1.2", … and so on recursively.
 *
 * Siblings are ordered by their stored wbs value (numeric segment comparison)
 * so that imported MS Project files produce codes that match the imported
 * OutlineNumber. Tasks with no stored wbs sort after coded siblings, ordered
 * by id for deterministic output.
 *
 * This function is pure: given the same input it always returns the same Map.
 * Callers should rerun it whenever the task list or tree structure changes.
 */
export function computeWbsCodes(tasks: Task[]): Map<string, string> {
  const childrenOf = new Map<string | null, Task[]>();
  for (const task of tasks) {
    const key = task.parentId ?? null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(task);
  }

  for (const siblings of childrenOf.values()) {
    siblings.sort(wbsCompare);
  }

  const codes = new Map<string, string>();
  assignCodes(null, '', childrenOf, codes);
  return codes;
}

function wbsCompare(a: Task, b: Task): number {
  const hasA = Boolean(a.wbs);
  const hasB = Boolean(b.wbs);
  if (!hasA && !hasB) return a.id.localeCompare(b.id);
  if (!hasA) return 1;
  if (!hasB) return -1;
  const aParts = a.wbs.split('.').map(Number);
  const bParts = b.wbs.split('.').map(Number);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.id.localeCompare(b.id);
}

function assignCodes(
  parentId: string | null,
  prefix: string,
  childrenOf: Map<string | null, Task[]>,
  codes: Map<string, string>,
): void {
  const siblings = childrenOf.get(parentId) ?? [];
  siblings.forEach((task, i) => {
    const code = prefix === '' ? `${i + 1}` : `${prefix}.${i + 1}`;
    codes.set(task.id, code);
    assignCodes(task.id, code, childrenOf, codes);
  });
}
