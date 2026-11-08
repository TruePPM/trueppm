import { describe, expect, it } from 'vitest';

import { heatCell, heatFill, heatInk, heatLabel } from './heat';
import { assignLabelRows, estimateLabelWidth, rowCount } from './labelPacking';
import { formatTick, linearScale, niceTicks, parseDate, timeTicks } from './scale';
import { linePath, stepPath } from './stepPath';

describe('linearScale', () => {
  it('maps domain ends to range ends and interpolates', () => {
    const s = linearScale([0, 100], [200, 0]);
    expect(s(0)).toBe(200);
    expect(s(100)).toBe(0);
    expect(s(25)).toBe(150);
  });
  it('maps a degenerate domain to the range midpoint', () => {
    expect(linearScale([5, 5], [0, 100])(5)).toBe(50);
  });
});

describe('dates and ticks', () => {
  it('parses date-only values as UTC midnight', () => {
    expect(parseDate('2026-06-05')).toBe(Date.UTC(2026, 5, 5));
  });
  it('formats a UTC day without shifting', () => {
    expect(formatTick(Date.UTC(2026, 5, 5))).toBe('Jun 5');
  });
  it('time ticks span the domain on whole days', () => {
    const a = Date.UTC(2026, 5, 1);
    const b = Date.UTC(2026, 5, 9);
    const t = timeTicks(a, b, 5);
    expect(t).toHaveLength(5);
    expect(t[0]).toBe(a);
    expect(t[4]).toBe(b);
    t.forEach((v) => expect(v % 86_400_000).toBe(0));
  });
  it('nice ticks land on 1/2/5 multiples and cover the max', () => {
    expect(niceTicks(0, 42, 4)).toEqual([0, 20, 40, 60]);
    expect(niceTicks(0, 100, 4)).toEqual([0, 50, 100]);
  });
});

describe('assignLabelRows (rule 413)', () => {
  it('keeps well-separated labels on row 0', () => {
    const rows = assignLabelRows([
      { key: 'a', x: 20, text: 'P50' },
      { key: 'b', x: 200, text: 'P80' },
    ]);
    expect(rowCount(rows)).toBe(1);
  });
  it('moves a colliding label to a new row and never rewrites x', () => {
    const labels = [
      { key: 'a', x: 100, text: 'P50' },
      { key: 'b', x: 104, text: 'P80' },
      { key: 'c', x: 108, text: 'P95' },
    ];
    const before = JSON.stringify(labels);
    const rows = assignLabelRows(labels);
    expect(new Set(rows.values()).size).toBe(3);
    expect(JSON.stringify(labels)).toBe(before);
  });
  it('reuses a row once the earlier occupant has ended', () => {
    const w = estimateLabelWidth('P50');
    const rows = assignLabelRows([
      { key: 'a', x: 100, text: 'P50' },
      { key: 'b', x: 102, text: 'P80' },
      { key: 'c', x: 100 + w + 20, text: 'P95' },
    ]);
    expect(rows.get('a')).toBe(0);
    expect(rows.get('b')).toBe(1);
    expect(rows.get('c')).toBe(0);
  });
  it('is order-independent for the packing and deterministic on ties', () => {
    const a = assignLabelRows([
      { key: 'x', x: 50, text: 'AA' },
      { key: 'y', x: 50, text: 'BB' },
    ]);
    expect(a.get('x')).toBe(0);
    expect(a.get('y')).toBe(1);
  });
});

describe('stepPath', () => {
  it('holds the value then jumps, with no curve commands', () => {
    const d = stepPath([
      [0, 10],
      [10, 20],
      [30, 5],
    ]);
    expect(d).toBe('M0 10 H10 V20 H30 V5');
    expect(d).not.toMatch(/[CQSTA]/);
  });
  it('is empty for no points', () => {
    expect(stepPath([])).toBe('');
  });
  it('linePath is a straight polyline', () => {
    expect(
      linePath([
        [0, 1],
        [2, 3],
      ]),
    ).toBe('M0 1 L2 3');
  });
});

describe('heatCell', () => {
  it.each([
    [0, 'none'],
    [null, 'none'],
    [Number.NaN, 'none'],
    [-5, 'none'],
  ])('%s is none', (v, kind) => {
    expect(heatCell(v).kind).toBe(kind);
  });
  it.each([
    [1, 1],
    [20, 1],
    [21, 2],
    [60, 3],
    [80, 4],
    [81, 5],
    [100, 5],
  ])('%s%% is sequential step %s', (v, n) => {
    expect(heatCell(v)).toEqual({ kind: 'step', n });
  });
  it('splits the over-allocation pair at 115', () => {
    expect(heatCell(101)).toEqual({ kind: 'over', n: 1 });
    expect(heatCell(115)).toEqual({ kind: 'over', n: 1 });
    expect(heatCell(116)).toEqual({ kind: 'over', n: 2 });
  });
  it('names every band in text and points fills at p1 tokens', () => {
    expect(heatLabel(heatCell(50))).toBe('41–60% load');
    expect(heatLabel(heatCell(130))).toMatch(/over-allocated/);
    expect(heatFill(heatCell(130))).toBe('oklch(var(--p1-over-2))');
    expect(heatInk(heatCell(95))).toBe('oklch(var(--p1-on-brand))');
  });
});
