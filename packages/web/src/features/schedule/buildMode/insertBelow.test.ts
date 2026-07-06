import { describe, it, expect } from 'vitest';
import { siblingParentId } from './insertBelow';
import type { Task } from '@/types';

/** Minimal Task factory — only the fields siblingParentId reads. */
function task(id: string, parentId: string | null): Task {
  return { id, parentId } as Task;
}

describe('siblingParentId (#1666 Enter = new sibling)', () => {
  const tasks = [
    task('root-a', null),
    task('summary', null),
    task('child-1', 'summary'),
    task('child-2', 'summary'),
  ];

  it('returns the parent of a nested row so the new row is a SIBLING, not root', () => {
    expect(siblingParentId(tasks, 'child-1')).toBe('summary');
  });

  it('returns null for a top-level row (a sibling of a root row is also root)', () => {
    expect(siblingParentId(tasks, 'root-a')).toBeNull();
    expect(siblingParentId(tasks, 'summary')).toBeNull();
  });

  it('returns null when the focused task is not found', () => {
    expect(siblingParentId(tasks, 'ghost')).toBeNull();
  });
});
