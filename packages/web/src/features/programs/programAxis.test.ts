import { describe, expect, it } from 'vitest';
import { axisPosition, buildAxis, epochDay } from './programAxis';

const row = (p50: string | null, p80: string | null, commitment_date: string | null = null) => ({
  p50,
  p80,
  commitment_date,
});

describe('programAxis', () => {
  it('spans every row on one axis so bands compare', () => {
    const axis = buildAxis([
      row('2027-01-01', '2027-02-01'),
      row('2027-01-15', '2027-03-01', '2027-02-15'),
    ]);
    expect(axis).not.toBeNull();
    const a = axis!;
    expect(a.start).toBeLessThan(epochDay('2027-01-01'));
    expect(a.end).toBeGreaterThan(epochDay('2027-03-01'));
    const early = axisPosition(a, '2027-02-01').pct;
    const late = axisPosition(a, '2027-03-01').pct;
    expect(early).toBeLessThan(late);
    expect(axisPosition(a, '2027-03-01').clamped).toBeNull();
  });

  it('clamps a date past the capped span to the edge and flags it', () => {
    const axis = buildAxis(
      [row('2027-01-01', '2027-02-01'), row('2027-01-10', '2030-01-01')],
      120,
    )!;
    expect(axis.end - axis.start).toBeLessThanOrEqual(120);
    expect(axisPosition(axis, '2030-01-01')).toEqual({ pct: 100, clamped: 'end' });
    expect(axisPosition(axis, '2026-01-01')).toEqual({ pct: 0, clamped: 'start' });
  });

  it('has no axis without dates and a visible width for one date', () => {
    expect(buildAxis([row(null, null)])).toBeNull();
    const one = buildAxis([row(null, '2027-01-01')])!;
    expect(one.end).toBeGreaterThan(one.start);
  });

  it('anchors on the densest window so one early outlier does not clamp every other row', () => {
    const axis = buildAxis(
      [
        row('2024-01-01', '2024-01-10'),
        row('2027-01-01', '2027-02-01'),
        row('2027-01-15', '2027-03-01', '2027-02-15'),
      ],
      120,
    )!;
    expect(axisPosition(axis, '2027-03-01').clamped).toBeNull();
    expect(axisPosition(axis, '2027-02-15').clamped).toBeNull();
    expect(axisPosition(axis, '2024-01-10')).toEqual({ pct: 0, clamped: 'start' });
  });

  it('flags a commitment past the axis like any other date', () => {
    const axis = buildAxis(
      [row('2027-01-01', '2027-02-01', '2031-01-01'), row('2027-01-10', '2027-02-10')],
      120,
    )!;
    expect(axisPosition(axis, '2031-01-01')).toEqual({ pct: 100, clamped: 'end' });
  });
});
