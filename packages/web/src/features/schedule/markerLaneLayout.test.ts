import { describe, expect, it } from 'vitest';
import { layoutMarkerLane, type LaneMarkerInput } from './markerLaneLayout';

// 10px per character, so every width below is exact.
const measure = (t: string) => t.length * 10;

const today = (x: number): LaneMarkerInput => ({
  kind: 'today',
  x,
  fullText: 'Today',
  shortText: 'Today',
  preferredSide: 'auto',
});
const p80 = (x: number): LaneMarkerInput => ({
  kind: 'p80',
  x,
  fullText: 'P80: Dec 10',
  shortText: 'P80',
  preferredSide: 'left',
});
const target = (x: number): LaneMarkerInput => ({
  kind: 'target',
  x,
  fullText: 'Target: Dec 1',
  shortText: 'Target',
  preferredSide: 'right',
});

function overlaps(a: { left: number; width: number }, b: { left: number; width: number }) {
  return a.left < b.left + b.width && b.left < a.left + a.width;
}

describe('layoutMarkerLane', () => {
  it('puts P80 left of its line and Target right of theirs', () => {
    const [pl, tl] = layoutMarkerLane([p80(500), target(530)], 1000, measure);
    expect(pl.side).toBe('left');
    expect(pl.left + pl.width).toBeLessThanOrEqual(500);
    expect(tl.side).toBe('right');
    expect(tl.left).toBeGreaterThanOrEqual(530);
    expect(overlaps(pl, tl)).toBe(false);
  });

  it('keeps P80 and Target apart when they land on the same day', () => {
    const [pl, tl] = layoutMarkerLane([p80(500), target(500)], 1000, measure);
    expect(pl.labelShown && tl.labelShown).toBe(true);
    expect(overlaps(pl, tl)).toBe(false);
  });

  it('never overlaps any two shown chips across a sweep of Today positions', () => {
    for (let x = 380; x <= 640; x += 3) {
      const placed = layoutMarkerLane([today(x), p80(500), target(530)], 1000, measure).filter(
        (p) => p.labelShown,
      );
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          expect(overlaps(placed[i], placed[j])).toBe(false);
        }
      }
    }
  });

  it('flips Today to the left when Target occupies its right', () => {
    const [t, , g] = layoutMarkerLane([today(500), p80(900), target(510)], 1000, measure);
    expect(g.labelShown).toBe(true);
    expect(t.side).toBe('left');
  });

  it('falls back to the short label before dropping a chip', () => {
    // "Target: Dec 1" (130px) fits on neither side of x=70 in a 140px viewport.
    const [tl] = layoutMarkerLane([target(70)], 140, measure);
    expect(tl.labelShown).toBe(true);
    expect(tl.text).toBe('Target');
  });

  it('keeps the tick but hides the label when nothing fits', () => {
    const [tl] = layoutMarkerLane([target(500)], 20, measure);
    expect(tl.labelShown).toBe(false);
    expect(tl.x).toBe(500);
  });

  it('returns placements in the caller order', () => {
    const out = layoutMarkerLane([target(600), today(100), p80(400)], 1000, measure);
    expect(out.map((p) => p.kind)).toEqual(['target', 'today', 'p80']);
  });
});
