import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import {
  DEFAULT_CELL_CAP,
  MIN_OVERFLOW_TO_COLLAPSE,
  isExceptionCard,
  selectVisibleCards,
} from './cellCap';

let seq = 0;
function makeTask(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    wbs: String(seq),
    name: `Task ${seq}`,
    start: '2026-01-13',
    finish: '2026-01-28',
    duration: 12,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    readiness: 'ready',
    assignees: [],
    notes: '',
    totalFloat: 3,
    ...overrides,
  };
}

/** N plain (non-exception, unassigned) calm cards. */
function calm(n: number): Task[] {
  return Array.from({ length: n }, () => makeTask());
}

const CAP = DEFAULT_CELL_CAP; // 6

describe('isExceptionCard', () => {
  it('flags critical-path cards', () => {
    expect(isExceptionCard(makeTask({ isCritical: true }), null)).toBe(true);
  });
  it('flags dependency-blocked cards', () => {
    expect(isExceptionCard(makeTask({ isBlocked: true }), null)).toBe(true);
  });
  it('flags human-flagged blocked cards (blockedAgeSeconds != null)', () => {
    expect(isExceptionCard(makeTask({ blockedAgeSeconds: 10 }), null)).toBe(true);
    // 0 is a real age (just flagged) — still an exception.
    expect(isExceptionCard(makeTask({ blockedAgeSeconds: 0 }), null)).toBe(true);
  });
  it('flags late cards (negative total float)', () => {
    expect(isExceptionCard(makeTask({ totalFloat: -1 }), null)).toBe(true);
    expect(isExceptionCard(makeTask({ totalFloat: 0 }), null)).toBe(false);
    expect(isExceptionCard(makeTask({ totalFloat: null }), null)).toBe(false);
  });
  it("flags the current user's own cards", () => {
    const mine = makeTask({ assignees: [{ resourceId: 'me', name: 'Me' } as never] });
    expect(isExceptionCard(mine, 'me')).toBe(true);
    expect(isExceptionCard(mine, 'someone-else')).toBe(false);
    expect(isExceptionCard(mine, null)).toBe(false);
  });
  it('does not flag a plain calm card', () => {
    expect(isExceptionCard(makeTask(), 'me')).toBe(false);
  });
});

describe('selectVisibleCards', () => {
  it('shows everything when the cell fits within the cap', () => {
    const tasks = calm(CAP);
    const { visible, overflow } = selectVisibleCards(tasks, { cap: CAP, myResourceId: null });
    expect(visible).toHaveLength(CAP);
    expect(overflow).toHaveLength(0);
  });

  it('does not collapse when only one card would be hidden (min-overflow threshold)', () => {
    // cap 6, 7 cards → hiding 1 is pure friction, show all.
    const tasks = calm(CAP + 1);
    const { visible, overflow } = selectVisibleCards(tasks, { cap: CAP, myResourceId: null });
    expect(visible).toHaveLength(CAP + 1);
    expect(overflow).toHaveLength(0);
  });

  it('collapses the calm tail once overflow reaches the threshold', () => {
    // cap 6, 8 calm cards → 6 visible, 2 overflow.
    const tasks = calm(CAP + MIN_OVERFLOW_TO_COLLAPSE);
    const { visible, overflow } = selectVisibleCards(tasks, { cap: CAP, myResourceId: null });
    expect(visible).toHaveLength(CAP);
    expect(overflow).toHaveLength(MIN_OVERFLOW_TO_COLLAPSE);
    // Overflow is the TAIL of the original order (order preserved).
    expect(overflow.map((t) => t.id)).toEqual(tasks.slice(CAP).map((t) => t.id));
  });

  it('preserves the original display order of the visible slice', () => {
    const tasks = calm(10);
    const { visible } = selectVisibleCards(tasks, { cap: CAP, myResourceId: null });
    expect(visible.map((t) => t.id)).toEqual(tasks.slice(0, CAP).map((t) => t.id));
  });

  it('never collapses an exception card — exceptions stay, calm tail overflows', () => {
    // 3 exceptions interleaved with 7 calm (10 total). All 3 exceptions kept +
    // 3 calm to fill the cap of 6; remaining 4 calm overflow.
    const tasks = [
      makeTask({ isCritical: true }), // exc
      ...calm(3),
      makeTask({ isBlocked: true }), // exc
      ...calm(2),
      makeTask({ blockedAgeSeconds: 5 }), // exc
      ...calm(2),
    ];
    const { visible, overflow } = selectVisibleCards(tasks, { cap: CAP, myResourceId: null });
    // Every exception is visible.
    expect(visible.filter((t) => isExceptionCard(t, null))).toHaveLength(3);
    // No exception ever appears in overflow.
    expect(overflow.every((t) => !isExceptionCard(t, null))).toBe(true);
    // Visible = 3 exceptions + 3 calm = 6; overflow = 4.
    expect(visible).toHaveLength(CAP);
    expect(overflow).toHaveLength(4);
  });

  it('shows ALL cards when exceptions alone exceed the cap and nothing calm is left to hide', () => {
    // 8 exceptions, 0 calm → nothing to collapse; show all (state c).
    const tasks = Array.from({ length: 8 }, () => makeTask({ isCritical: true }));
    const { visible, overflow } = selectVisibleCards(tasks, { cap: CAP, myResourceId: null });
    expect(visible).toHaveLength(8);
    expect(overflow).toHaveLength(0);
  });

  it('keeps the current user’s own cards visible even in the tail', () => {
    // 6 calm then 2 of mine at the tail: mine are exceptions, so they stay
    // visible and calm cards overflow instead.
    const mine = () => makeTask({ assignees: [{ resourceId: 'me', name: 'Me' } as never] });
    const tasks = [...calm(6), mine(), mine()];
    const { visible, overflow } = selectVisibleCards(tasks, { cap: CAP, myResourceId: 'me' });
    // Both of my cards are visible; none of mine is hidden.
    expect(overflow.some((t) => t.assignees.some((a) => a.resourceId === 'me'))).toBe(false);
    expect(visible.filter((t) => t.assignees.some((a) => a.resourceId === 'me'))).toHaveLength(2);
  });
});
