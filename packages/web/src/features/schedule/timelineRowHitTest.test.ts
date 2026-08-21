import { describe, expect, it } from 'vitest';
import { timelineRowIndexAt } from './timelineRowHitTest';
import { HEADER_HEIGHT, ROW_HEIGHT } from './scheduleConstants';

describe('timelineRowIndexAt', () => {
  it('resolves the first row just below the ruler', () => {
    expect(timelineRowIndexAt(HEADER_HEIGHT, 0, 5)).toBe(0);
    expect(timelineRowIndexAt(HEADER_HEIGHT + ROW_HEIGHT - 1, 0, 5)).toBe(0);
  });

  it('advances a row per ROW_HEIGHT', () => {
    expect(timelineRowIndexAt(HEADER_HEIGHT + ROW_HEIGHT, 0, 5)).toBe(1);
    expect(timelineRowIndexAt(HEADER_HEIGHT + ROW_HEIGHT * 3, 0, 5)).toBe(3);
  });

  it('returns null over the ruler — a month header is not a task', () => {
    expect(timelineRowIndexAt(0, 0, 5)).toBeNull();
    expect(timelineRowIndexAt(HEADER_HEIGHT - 1, 0, 5)).toBeNull();
  });

  it('returns null past the last row rather than clamping to it', () => {
    // Clamping would open the last task's menu from empty space below the plan,
    // which is worse than doing nothing.
    expect(timelineRowIndexAt(HEADER_HEIGHT + ROW_HEIGHT * 5, 0, 5)).toBeNull();
    expect(timelineRowIndexAt(HEADER_HEIGHT + ROW_HEIGHT * 40, 0, 5)).toBeNull();
  });

  it('accounts for scroll', () => {
    // Scrolled down two rows, the top visible row is index 2.
    expect(timelineRowIndexAt(HEADER_HEIGHT, ROW_HEIGHT * 2, 10)).toBe(2);
  });

  it('handles an empty plan without resolving anything', () => {
    expect(timelineRowIndexAt(HEADER_HEIGHT, 0, 0)).toBeNull();
  });
});
