import { describe, it, expect } from 'vitest';
import { buildWbsTree, flattenVisible, collectAllIds } from './buildWbsTree';
import type { Task } from '@/types';

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'wbs'>): Task {
  return {
    name: overrides.id,
    start: '2026-01-01',
    finish: '2026-01-05',
    duration: 4,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    ...overrides,
  };
}

const FLAT_TASKS: Task[] = [
  makeTask({ id: 't1', wbs: '1', isSummary: true, parentId: null }),
  makeTask({ id: 't2', wbs: '1.1', parentId: 't1' }),
  makeTask({ id: 't3', wbs: '1.2', parentId: 't1' }),
  makeTask({ id: 't4', wbs: '2', parentId: null }),
  makeTask({ id: 't5', wbs: '1.1.1', parentId: 't2' }),
];

describe('buildWbsTree', () => {
  it('builds a two-level tree correctly', () => {
    const tree = buildWbsTree(FLAT_TASKS);
    expect(tree).toHaveLength(2); // t1, t4 at root
    expect(tree[0].task.id).toBe('t1');
    expect(tree[0].children).toHaveLength(2); // t2, t3
    expect(tree[1].task.id).toBe('t4');
  });

  it('assigns correct depth values', () => {
    const tree = buildWbsTree(FLAT_TASKS);
    expect(tree[0].depth).toBe(0);
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it('sorts siblings by wbs number', () => {
    const tasks = [
      makeTask({ id: 't3', wbs: '1.3', parentId: 'root' }),
      makeTask({ id: 't1', wbs: '1.1', parentId: 'root' }),
      makeTask({ id: 't2', wbs: '1.2', parentId: 'root' }),
      makeTask({ id: 'root', wbs: '1', isSummary: true, parentId: null }),
    ];
    const tree = buildWbsTree(tasks);
    const sibs = tree[0].children.map((n) => n.task.wbs);
    expect(sibs).toEqual(['1.1', '1.2', '1.3']);
  });

  it('handles empty input', () => {
    expect(buildWbsTree([])).toEqual([]);
  });

  it('handles flat tasks with no children', () => {
    const tasks = [
      makeTask({ id: 'a', wbs: '1' }),
      makeTask({ id: 'b', wbs: '2' }),
    ];
    const tree = buildWbsTree(tasks);
    expect(tree).toHaveLength(2);
    expect(tree[0].children).toHaveLength(0);
  });
});

describe('flattenVisible', () => {
  it('returns only root nodes when nothing is expanded', () => {
    const tree = buildWbsTree(FLAT_TASKS);
    const visible = flattenVisible(tree, new Set());
    expect(visible.map((n) => n.task.id)).toEqual(['t1', 't4']);
  });

  it('includes children when parent is expanded', () => {
    const tree = buildWbsTree(FLAT_TASKS);
    const visible = flattenVisible(tree, new Set(['t1']));
    const ids = visible.map((n) => n.task.id);
    expect(ids).toContain('t2');
    expect(ids).toContain('t3');
    expect(ids).not.toContain('t5'); // t2 not expanded
  });

  it('includes grandchildren when two levels expanded', () => {
    const tree = buildWbsTree(FLAT_TASKS);
    const visible = flattenVisible(tree, new Set(['t1', 't2']));
    const ids = visible.map((n) => n.task.id);
    expect(ids).toContain('t5');
  });
});

describe('collectAllIds', () => {
  it('collects all node ids recursively', () => {
    const tree = buildWbsTree(FLAT_TASKS);
    const ids = collectAllIds(tree);
    expect(ids.sort()).toEqual(['t1', 't2', 't3', 't4', 't5'].sort());
  });

  it('returns empty array for empty tree', () => {
    expect(collectAllIds([])).toEqual([]);
  });
});

describe('buildWbsTree — parentWbs branch', () => {
  it('sets parentWbs to parent wbs string when parent exists', () => {
    const tree = buildWbsTree(FLAT_TASKS);
    // t2 is a child of t1 (wbs='1') — parentWbs should be '1'
    const t2Node = tree[0].children[0];
    expect(t2Node.task.id).toBe('t2');
    expect(t2Node.parentWbs).toBe('1');
  });

  it('sets parentWbs to empty string for root nodes', () => {
    const tree = buildWbsTree(FLAT_TASKS);
    // t1 is a root node — parentWbs should be ''
    expect(tree[0].parentWbs).toBe('');
  });

  it('handles task with parentId that does not exist in the task list (orphan)', () => {
    // parentId points to a non-existent task — byId.get returns undefined
    const tasks = [
      makeTask({ id: 'a', wbs: '1', parentId: 'missing-parent' }),
    ];
    // 'a' won't appear under null-parent children so tree is empty
    const tree = buildWbsTree(tasks);
    // 'a' is not under null key, so tree is empty — no crash
    expect(tree).toHaveLength(0);
  });

  it('wbsCompare handles missing wbs segments (treats missing as 0)', () => {
    // Two tasks with different wbs depths — shorter one gets 0 for missing segment
    const tasks = [
      makeTask({ id: 'b', wbs: '1.2', parentId: null }),
      makeTask({ id: 'a', wbs: '1', parentId: null }),
    ];
    const tree = buildWbsTree(tasks);
    // '1' < '1.2' — 'a' should come first
    expect(tree[0].task.id).toBe('a');
    expect(tree[1].task.id).toBe('b');
  });
});

describe('flattenVisible — collapsed subtrees', () => {
  it('returns empty array for empty tree', () => {
    expect(flattenVisible([], new Set())).toEqual([]);
  });

  it('does not include children of leaf nodes even if their id is in expandedIds', () => {
    // t4 is a leaf (no children) — even if its id is in the set, no extra nodes appear
    const tree = buildWbsTree(FLAT_TASKS);
    const visible = flattenVisible(tree, new Set(['t4']));
    // only root nodes visible (t1, t4) since t1 is not expanded
    expect(visible.map((n) => n.task.id)).toEqual(['t1', 't4']);
  });
});
