import { describe, it, expect } from 'vitest';
import {
  applyHideNonMatching,
  classifyScheduleRows,
  contextHint,
  isArrowDimmed,
  isRowDimmed,
  rowFilterState,
} from './scheduleLabelFilter';
import type { Task, TaskLabel } from '@/types';

const RED: TaskLabel = { id: 'l-red', name: 'Red', color: 'red' };
const BLUE: TaskLabel = { id: 'l-blue', name: 'Blue', color: 'blue' };

function task(
  id: string,
  opts: { parentId?: string | null; labels?: TaskLabel[]; isSummary?: boolean } = {},
): Task {
  return {
    id,
    name: id,
    parentId: opts.parentId ?? null,
    isSummary: opts.isSummary ?? false,
    labels: opts.labels,
  } as unknown as Task;
}

/**
 * Phase 1 ─ Design (Red)
 *         └ Build
 * Phase 2 ─ Ship (Blue)
 * Loose   (no parent, no labels)
 */
const TREE: Task[] = [
  task('p1', { isSummary: true }),
  task('design', { parentId: 'p1', labels: [RED] }),
  task('build', { parentId: 'p1' }),
  task('p2', { isSummary: true }),
  task('ship', { parentId: 'p2', labels: [BLUE] }),
  task('loose'),
];

describe('classifyScheduleRows', () => {
  it('is inactive with no selection', () => {
    const c = classifyScheduleRows(TREE, []);
    expect(c.isInactive).toBe(true);
    expect(c.stateById.size).toBe(0);
  });

  it('marks labeled rows as matches', () => {
    const c = classifyScheduleRows(TREE, ['l-red']);
    expect(rowFilterState(c, 'design')).toBe('match');
    expect(c.matchCount).toBe(1);
  });

  it('marks a summary whose child matches as context, not match', () => {
    const c = classifyScheduleRows(TREE, ['l-red']);
    expect(rowFilterState(c, 'p1')).toBe('context');
    expect(isRowDimmed(c, 'p1')).toBe(false);
  });

  it('dims a summary with no matching descendants', () => {
    const c = classifyScheduleRows(TREE, ['l-red']);
    expect(rowFilterState(c, 'p2')).toBe('dim');
    expect(rowFilterState(c, 'ship')).toBe('dim');
  });

  it('dims a non-matching sibling of a match', () => {
    const c = classifyScheduleRows(TREE, ['l-red']);
    expect(isRowDimmed(c, 'build')).toBe(true);
  });

  it('ORs within the facet', () => {
    const c = classifyScheduleRows(TREE, ['l-red', 'l-blue']);
    expect(c.matchCount).toBe(2);
    expect(rowFilterState(c, 'p1')).toBe('context');
    expect(rowFilterState(c, 'p2')).toBe('context');
    expect(isRowDimmed(c, 'loose')).toBe(true);
  });

  it('treats a matching summary as a match rather than context', () => {
    const rows = [task('p', { isSummary: true, labels: [RED] }), task('kid', { parentId: 'p' })];
    const c = classifyScheduleRows(rows, ['l-red']);
    expect(rowFilterState(c, 'p')).toBe('match');
    expect(contextHint(c, 'p')).toBeNull();
  });
});

describe('zero matches', () => {
  it('suppresses dimming entirely rather than dimming everything', () => {
    const c = classifyScheduleRows(TREE, ['l-nonexistent']);
    expect(c.isZeroMatch).toBe(true);
    expect(c.matchCount).toBe(0);
    // Every row reads at full contrast — dimming all of them looks broken.
    for (const t of TREE) expect(isRowDimmed(c, t.id)).toBe(false);
  });

  it('leaves arrows at full contrast', () => {
    const c = classifyScheduleRows(TREE, ['l-nonexistent']);
    expect(isArrowDimmed(c, 'build', 'ship')).toBe(false);
  });

  it('does not hide anything even with hide-non-matching on', () => {
    const c = classifyScheduleRows(TREE, ['l-nonexistent']);
    expect(applyHideNonMatching(TREE, c, true)).toHaveLength(TREE.length);
  });
});

describe('context hints', () => {
  it('counts matching leaves against total leaves', () => {
    const c = classifyScheduleRows(TREE, ['l-red']);
    // p1 has two leaf children; one carries the label.
    expect(contextHint(c, 'p1')).toBe('1 of 2 match');
  });

  it('does not count sub-phases as work items', () => {
    const rows = [
      task('root', { isSummary: true }),
      task('sub', { parentId: 'root', isSummary: true }),
      task('a', { parentId: 'sub', labels: [RED] }),
      task('b', { parentId: 'sub' }),
    ];
    const c = classifyScheduleRows(rows, ['l-red']);
    // Two leaves under root (a, b) — `sub` itself is not a work item.
    expect(contextHint(c, 'root')).toBe('1 of 2 match');
  });

  it('returns null for rows that are not context', () => {
    const c = classifyScheduleRows(TREE, ['l-red']);
    expect(contextHint(c, 'design')).toBeNull();
    expect(contextHint(c, 'p2')).toBeNull();
  });

  it('is independent of collapse state', () => {
    // The tally is computed over ALL tasks, so a collapsed p1 keeps its hint.
    const c = classifyScheduleRows(TREE, ['l-red']);
    const visibleWhenCollapsed = [TREE[0], TREE[3], TREE[5]];
    expect(contextHint(c, 'p1')).toBe('1 of 2 match');
    expect(visibleWhenCollapsed.map((t) => rowFilterState(c, t.id))).toEqual([
      'context',
      'dim',
      'dim',
    ]);
  });
});

describe('isArrowDimmed', () => {
  it('dims an arrow only when both endpoints are dimmed', () => {
    const c = classifyScheduleRows(TREE, ['l-red']);
    expect(isArrowDimmed(c, 'ship', 'loose')).toBe(true);
  });

  it('keeps an arrow from a dimmed predecessor to a match at full contrast', () => {
    const c = classifyScheduleRows(TREE, ['l-red']);
    // The dimmed predecessor is the explanation for where the matching bar sits.
    expect(isArrowDimmed(c, 'build', 'design')).toBe(false);
    expect(isArrowDimmed(c, 'design', 'build')).toBe(false);
  });

  it('never dims when the filter is off', () => {
    const c = classifyScheduleRows(TREE, []);
    expect(isArrowDimmed(c, 'ship', 'loose')).toBe(false);
  });
});

describe('applyHideNonMatching', () => {
  it('is a no-op when off', () => {
    const c = classifyScheduleRows(TREE, ['l-red']);
    expect(applyHideNonMatching(TREE, c, false)).toHaveLength(TREE.length);
  });

  it('keeps matches and context rows, drops the rest', () => {
    const c = classifyScheduleRows(TREE, ['l-red']);
    const kept = applyHideNonMatching(TREE, c, true).map((t) => t.id);
    // p1 survives so `design` is not orphaned in the outline.
    expect(kept).toEqual(['p1', 'design']);
  });

  it('is a no-op when the filter is off', () => {
    const c = classifyScheduleRows(TREE, []);
    expect(applyHideNonMatching(TREE, c, true)).toHaveLength(TREE.length);
  });
});

describe('robustness', () => {
  it('defaults an unknown row to full contrast, never to dimmed', () => {
    const c = classifyScheduleRows(TREE, ['l-red']);
    expect(rowFilterState(c, 'never-seen')).toBe('match');
    expect(isRowDimmed(c, 'never-seen')).toBe(false);
  });

  it('terminates on a cyclic parentId rather than overflowing', () => {
    const rows = [
      task('a', { parentId: 'b', labels: [RED] }),
      task('b', { parentId: 'a' }),
    ];
    expect(() => classifyScheduleRows(rows, ['l-red'])).not.toThrow();
  });

  it('treats a row with no labels field as a non-match', () => {
    const rows = [task('bare')];
    const c = classifyScheduleRows(rows, ['l-red']);
    expect(c.isZeroMatch).toBe(true);
  });
});
