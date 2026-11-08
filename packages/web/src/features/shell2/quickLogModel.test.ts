import { describe, it, expect } from 'vitest';
import {
  MAX_HOURS,
  buildEntries,
  formatHours,
  spokenHours,
  stepHours,
  totalHours,
} from './quickLogModel';

describe('stepHours', () => {
  it('steps by half an hour', () => {
    expect(stepHours(0, 1)).toBe(0.5);
    expect(stepHours(0.5, 1)).toBe(1);
    expect(stepHours(2, -1)).toBe(1.5);
  });
  it('clamps at zero and the daily maximum', () => {
    expect(stepHours(0, -1)).toBe(0);
    expect(stepHours(MAX_HOURS, 1)).toBe(MAX_HOURS);
  });
  it('snaps an off-grid value back onto the half-hour grid', () => {
    expect(stepHours(0.3, 1)).toBe(1);
  });
});

describe('formatting', () => {
  it('formats compact and spoken hours', () => {
    expect(formatHours(0)).toBe('0h');
    expect(formatHours(1.5)).toBe('1.5h');
    expect(formatHours(2)).toBe('2h');
    expect(spokenHours(1)).toBe('1 hour');
    expect(spokenHours(1.5)).toBe('1.5 hours');
    expect(spokenHours(0)).toBe('0 hours');
  });
});

describe('buildEntries', () => {
  it('posts only positive values, in list order, as minutes', () => {
    expect(buildEntries(['a', 'b', 'c'], { c: 0.5, a: 1.5, b: 0 })).toEqual([
      { taskId: 'a', minutes: 90 },
      { taskId: 'c', minutes: 30 },
    ]);
  });
  it('is empty when nothing was stepped up', () => {
    expect(buildEntries(['a'], {})).toEqual([]);
  });
  it('ignores values for tasks no longer listed', () => {
    expect(buildEntries(['a'], { gone: 2 })).toEqual([]);
  });
});

describe('totalHours', () => {
  it('sums the sheet', () => {
    expect(totalHours({ a: 1.5, b: 0.5 })).toBe(2);
    expect(totalHours({})).toBe(0);
  });
});
