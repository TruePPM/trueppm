import { describe, it, expect } from 'vitest';
import {
  barExtent,
  barBox,
  fsConnectorPath,
  MILESTONE_HALF_PX,
  CONNECTOR_STUB_PX,
  type BarBox,
} from './scheduleArrowGeometry';
import { buildScaleDataFromPxPerDay, dateToLeft, dateToRight } from '../engine';
import type { SchedulePrintRow } from './schedulePrintData';

function prow(overrides: Partial<SchedulePrintRow> = {}): SchedulePrintRow {
  return {
    id: 't',
    wbsCode: '1',
    depth: 1,
    indentLevel: 1,
    kind: 'task',
    name: 't',
    owner: null,
    ownerInitials: null,
    start: '2026-04-05',
    finish: '2026-04-10',
    pctComplete: 0,
    isCritical: false,
    totalFloat: null,
    riskBand: 'on-track',
    isMilestone: false,
    milestoneMet: null,
    ...overrides,
  };
}

// A print-width scale over April; the geometry helpers must defer all X math to
// the engine's dateToLeft/dateToRight, never re-derive it.
const scales = buildScaleDataFromPxPerDay(10, '2026-04-01', '2026-04-30');

describe('barExtent', () => {
  it('runs a normal bar from dateToLeft(start) to dateToRight(finish)', () => {
    const row = prow({ start: '2026-04-05', finish: '2026-04-10' });
    const ext = barExtent(row, scales);
    expect(ext.left).toBe(dateToLeft('2026-04-05', scales));
    expect(ext.right).toBe(dateToRight('2026-04-10', scales));
    expect(ext.right).toBeGreaterThan(ext.left);
  });

  it('widens a milestone to its diamond half-diagonal around the start point', () => {
    const row = prow({ isMilestone: true, start: '2026-04-08', finish: '2026-04-08' });
    const center = dateToLeft('2026-04-08', scales);
    const ext = barExtent(row, scales);
    expect(ext.left).toBe(center - MILESTONE_HALF_PX);
    expect(ext.right).toBe(center + MILESTONE_HALF_PX);
  });

  it('returns a zero-width extent at the origin for an undated row', () => {
    const row = prow({ start: null, finish: null });
    expect(barExtent(row, scales)).toEqual({ left: 0, right: 0 });
  });
});

describe('barBox', () => {
  it('carries the row-center Y through alongside the bar extent', () => {
    const row = prow({ start: '2026-04-05', finish: '2026-04-10' });
    const box = barBox(row, 42, scales);
    expect(box.centerY).toBe(42);
    expect(box.left).toBe(dateToLeft('2026-04-05', scales));
    expect(box.right).toBe(dateToRight('2026-04-10', scales));
  });
});

describe('fsConnectorPath', () => {
  it('starts at the source right edge and ends at the target left edge', () => {
    const from: BarBox = { left: 0, right: 100, centerY: 10 };
    const to: BarBox = { left: 300, right: 400, centerY: 50 };
    const d = fsConnectorPath(from, to);
    expect(d.startsWith('M 100 10')).toBe(true);
    expect(d.endsWith('L 300 50')).toBe(true);
    // 3-segment orthogonal path: one move + three lines.
    expect((d.match(/L /g) ?? []).length).toBe(3);
  });

  it('routes the vertical channel midway when the target has forward slack', () => {
    const from: BarBox = { left: 0, right: 100, centerY: 10 };
    const to: BarBox = { left: 300, right: 400, centerY: 50 };
    const channelX = (100 + 300) / 2; // 200
    expect(fsConnectorPath(from, to)).toContain(`L ${channelX} 10`);
    expect(fsConnectorPath(from, to)).toContain(`L ${channelX} 50`);
  });

  it('uses a forward stub when the target starts at/behind the source finish', () => {
    const from: BarBox = { left: 0, right: 300, centerY: 10 };
    const to: BarBox = { left: 305, right: 400, centerY: 50 }; // 305 - stub(10) <= 300
    const channelX = 300 + CONNECTOR_STUB_PX; // 310
    expect(fsConnectorPath(from, to)).toContain(`L ${channelX} 10`);
  });
});
