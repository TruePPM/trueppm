import { describe, it, expect } from 'vitest';
import { buildDependencyPaths, type DepAnchor } from './scheduleSharePaths';
import type { PublicScheduleDependency } from './scheduleShareApi';

function dep(overrides: Partial<PublicScheduleDependency> = {}): PublicScheduleDependency {
  return {
    predecessor_short_id: 'P',
    successor_short_id: 'S',
    dep_type: 'FS',
    lag: 0,
    ...overrides,
  };
}

// P: row 0, bar spans 0%..10%. S: row 1, bar spans 20%..40%.
const anchors = new Map<string, DepAnchor>([
  ['P', { startPct: 0, endPct: 10, rowIndex: 0 }],
  ['S', { startPct: 20, endPct: 40, rowIndex: 1 }],
]);

const WIDTH = 1000;
const ROW_H = 28;

describe('buildDependencyPaths', () => {
  it('returns nothing until the timeline width is measured', () => {
    expect(buildDependencyPaths(anchors, [dep()], 0, ROW_H)).toEqual([]);
    expect(buildDependencyPaths(anchors, [dep()], -5, ROW_H)).toEqual([]);
  });

  it('anchors an FS edge from the predecessor finish to the successor start', () => {
    const [seg] = buildDependencyPaths(anchors, [dep({ dep_type: 'FS' })], WIDTH, ROW_H);
    // src = P.end (10% → 100px), row 0 center y=14; tgt = S.start (20% → 200px), row 1 center y=42.
    // exit stub +8 (finish exits right) → ex=108; then drop to y=42; run in to x=200.
    expect(seg.d).toBe('M 100 14 H 108 V 42 H 200');
    // arrowhead points right (tx 200 > ex 108), apex at (200,42).
    expect(seg.arrow).toBe('200,42 195,37 195,47');
    expect(seg.key).toBe('P->S:FS');
  });

  it('anchors an SS edge from both start edges and exits left', () => {
    const [seg] = buildDependencyPaths(anchors, [dep({ dep_type: 'SS' })], WIDTH, ROW_H);
    // src = P.start (0% → 0px), exit stub -8 (start exits left) → ex=-8; tgt = S.start (200px).
    expect(seg.d).toBe('M 0 14 H -8 V 42 H 200');
    expect(seg.key).toBe('P->S:SS');
  });

  it('anchors an FF edge to the successor finish edge', () => {
    const [seg] = buildDependencyPaths(anchors, [dep({ dep_type: 'FF' })], WIDTH, ROW_H);
    // src = P.end (100px, exit right → ex=108); tgt = S.end (40% → 400px).
    expect(seg.d).toBe('M 100 14 H 108 V 42 H 400');
  });

  it('anchors an SF edge from the predecessor start to the successor finish', () => {
    const [seg] = buildDependencyPaths(anchors, [dep({ dep_type: 'SF' })], WIDTH, ROW_H);
    // src = P.start (0px, exit left → ex=-8); tgt = S.end (400px).
    expect(seg.d).toBe('M 0 14 H -8 V 42 H 400');
  });

  it('defaults an unknown/blank dep_type to FS anchoring', () => {
    const [seg] = buildDependencyPaths(anchors, [dep({ dep_type: '' })], WIDTH, ROW_H);
    expect(seg.d).toBe('M 100 14 H 108 V 42 H 200');
  });

  it('skips an edge whose endpoint is missing (truncated/deleted away)', () => {
    expect(
      buildDependencyPaths(anchors, [dep({ successor_short_id: 'GONE' })], WIDTH, ROW_H),
    ).toEqual([]);
    expect(
      buildDependencyPaths(anchors, [dep({ predecessor_short_id: 'GONE' })], WIDTH, ROW_H),
    ).toEqual([]);
  });

  it('skips an edge when the anchored edge is unscheduled (null pct)', () => {
    const unscheduled = new Map<string, DepAnchor>([
      ['P', { startPct: null, endPct: null, rowIndex: 0 }],
      ['S', { startPct: 20, endPct: 40, rowIndex: 1 }],
    ]);
    // FS reads P.end (null) → skipped.
    expect(buildDependencyPaths(unscheduled, [dep({ dep_type: 'FS' })], WIDTH, ROW_H)).toEqual([]);
  });

  it('points the arrowhead left when the target sits left of the exit stub', () => {
    // S bar sits to the LEFT of P: successor start at 2% (20px) < ex.
    const back = new Map<string, DepAnchor>([
      ['P', { startPct: 50, endPct: 60, rowIndex: 0 }],
      ['S', { startPct: 2, endPct: 8, rowIndex: 1 }],
    ]);
    const [seg] = buildDependencyPaths(back, [dep({ dep_type: 'FS' })], WIDTH, ROW_H);
    // src P.end 60% → 600px, ex=608; tgt S.start 2% → 20px < ex → arrow points left.
    // ax = 20 - (-5) = 25.
    expect(seg.arrow).toBe('20,42 25,37 25,47');
  });
});
