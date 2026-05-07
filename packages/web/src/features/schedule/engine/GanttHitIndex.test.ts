import { describe, it, expect } from 'vitest';
import { buildHitIndex, ROW_HEIGHT, BAR_TOP_OFFSET, BAR_HEIGHT } from './GanttHitIndex';
import { buildScaleData } from './GanttScaleData';
import { HEADER_HEIGHT } from '../scheduleConstants';
import type { Task } from '@/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const scales = buildScaleData('week', '2026-04-01', '2026-05-01');

function makeTask(id: string, start: string, finish: string): Task {
  return {
    id,
    name: `Task ${id}`,
    start,
    finish,
    duration: 7,
    progress: 0,
    wbs: '1',
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
  };
}

const taskA = makeTask('a', '2026-04-07', '2026-04-14'); // row 0
const taskB = makeTask('b', '2026-04-14', '2026-04-21'); // row 1

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

// Precompute expected bar positions for taskA (row 0)
const barLeftA = scales.pxPerMs * (new Date('2026-04-07T00:00:00Z').getTime() - scales.start.getTime());
const barRightA = scales.pxPerMs * (new Date('2026-04-14T00:00:00Z').getTime() - scales.start.getTime());
const barTopA = HEADER_HEIGHT + BAR_TOP_OFFSET;  // row 0: 0 * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET
const barBottomA = barTopA + BAR_HEIGHT;

// taskB (row 1)
const barLeftB = scales.pxPerMs * (new Date('2026-04-14T00:00:00Z').getTime() - scales.start.getTime());
const barRightB = scales.pxPerMs * (new Date('2026-04-21T00:00:00Z').getTime() - scales.start.getTime());
const barTopB = HEADER_HEIGHT + ROW_HEIGHT + BAR_TOP_OFFSET; // row 1: 1 * ROW_HEIGHT + HEADER_HEIGHT + BAR_TOP_OFFSET

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildHitIndex', () => {
  it('returns null when task list is empty', () => {
    const idx = buildHitIndex([], scales);
    expect(idx.query(100, 10, false)).toBeNull();
  });

  // ── Bar body hit ──────────────────────────────────────────────────────────

  it('hits bar body of row 0 (mouse)', () => {
    const idx = buildHitIndex([taskA], scales);
    // Hit the middle of the bar (away from resize handle)
    const midX = barLeftA + (barRightA - barLeftA) / 2;
    const midY = barTopA + BAR_HEIGHT / 2;
    const zone = idx.query(midX, midY, false);
    expect(zone).not.toBeNull();
    expect(zone!.taskId).toBe('a');
    expect(zone!.type).toBe('bar');
    expect(zone!.rowIndex).toBe(0);
  });

  it('hits bar body of row 1', () => {
    const idx = buildHitIndex([taskA, taskB], scales);
    const midX = barLeftB + (barRightB - barLeftB) / 2;
    const midY = barTopB + BAR_HEIGHT / 2;
    const zone = idx.query(midX, midY, false);
    expect(zone).not.toBeNull();
    expect(zone!.taskId).toBe('b');
    expect(zone!.rowIndex).toBe(1);
  });

  it('returns null for a click below all rows', () => {
    const idx = buildHitIndex([taskA], scales);
    const zone = idx.query(barLeftA + 10, ROW_HEIGHT * 5, false);
    expect(zone).toBeNull();
  });

  it('returns null for a click in the row band but outside bar left', () => {
    const idx = buildHitIndex([taskA], scales);
    // x is before barLeft
    const zone = idx.query(barLeftA - 10, barTopA + 5, false);
    expect(zone).toBeNull();
  });

  // ── Resize handle ─────────────────────────────────────────────────────────

  it('hits resize handle near right edge (mouse)', () => {
    const idx = buildHitIndex([taskA], scales);
    // Resize zone (mouse): [barRight - 16, barRight + 8] × [barTop, barBottom]
    const resizeX = barRightA - 4; // inside resize zone
    const zone = idx.query(resizeX, barTopA + 5, false);
    expect(zone).not.toBeNull();
    expect(zone!.type).toBe('resize');
    expect(zone!.taskId).toBe('a');
  });

  it('resize zone expands on touch ([barRight-12, barRight+8])', () => {
    const idx = buildHitIndex([taskA], scales);
    // Mouse resize zone is [barRight-16, barRight+8], touch is [barRight-12, barRight+8].
    // Touch is narrower on the left side but still reaches barRight-12.
    // Test at barRight-15: inside mouse zone but outside touch zone.
    const edgeX = barRightA - 15;
    const mouseZone = idx.query(edgeX, barTopA + 5, false);
    const touchZone = idx.query(edgeX, barTopA + 5, true);
    expect(mouseZone?.type).toBe('resize');       // inside mouse zone (>= barRight-16)
    expect(touchZone?.type).not.toBe('resize');   // outside touch zone (< barRight-12)
  });

  it('bar body is adjacent to resize zone (no overlap)', () => {
    const idx = buildHitIndex([taskA], scales);
    // Just left of resize zone: barRight - 17 → should be bar body
    const barBodyX = barRightA - 17;
    const zone = idx.query(barBodyX, barTopA + 5, false);
    expect(zone?.type).toBe('bar');
  });

  // ── Link-dot zone ─────────────────────────────────────────────────────────

  it('hits link-dot zone to the right of the bar (mouse)', () => {
    const idx = buildHitIndex([taskA], scales);
    // Link-dot zone: [barRight + 4, barRight + 16] × [barTop, barBottom]
    const linkX = barRightA + 8;
    const zone = idx.query(linkX, barTopA + 5, false);
    expect(zone).not.toBeNull();
    expect(zone!.type).toBe('link-dot');
    expect(zone!.taskId).toBe('a');
  });

  it('link-dot zone expands to 44px tall on touch', () => {
    const idx = buildHitIndex([taskA], scales);
    const linkX = barRightA + 8;
    // On mouse: zone is barTop..barBottom (18px) — outside is null
    const aboveBar = barTopA - 5; // above bar top
    expect(idx.query(linkX, aboveBar, false)).toBeNull();
    // On touch: zone expands to 44px centered in the row (rowTop + ROW_HEIGHT/2)
    // rowTop = HEADER_HEIGHT = 28; center = 28 + 14 = 42; expanded zone: [20, 64]
    // aboveBar = barTopA - 5 = HEADER_HEIGHT + BAR_TOP_OFFSET - 5 = 28 → 28 >= 20 → within zone
    const touchZone = idx.query(linkX, aboveBar, true);
    expect(touchZone?.type).toBe('link-dot');
  });

  it('returns null in gap between bar right edge and link-dot left (barRight to barRight+4)', () => {
    const idx = buildHitIndex([taskA], scales);
    // Gap: [barRight, barRight + 4] — neither resize nor link-dot
    const gapX = barRightA + 2;
    // This is outside bar body (barRight - 8 cutoff) and before link-dot (barRight + 4)
    // But within the resize handle right overhang zone [barRight - 8, barRight + 4]
    // So it IS the resize zone
    const zone = idx.query(gapX, barTopA + 5, false);
    expect(zone?.type).toBe('resize');
  });

  // ── Priority: link-dot > resize > bar body ────────────────────────────────

  it('link-dot wins over resize when zones overlap (at barRight + 8)', () => {
    const idx = buildHitIndex([taskA], scales);
    // barRight + 8 is the boundary: resize zone ends here, link-dot zone starts here
    // The query checks link-dot first, so link-dot should win
    const boundaryX = barRightA + 8;
    const zone = idx.query(boundaryX, barTopA + 5, false);
    // link-dot zone starts at barRight + 8 (RESIZE_RIGHT_OVERHANG)
    expect(zone?.type).toBe('link-dot');
  });

  // ── HitZone fields ────────────────────────────────────────────────────────

  it('returns correct barLeft, barRight, barTop, barBottom on hit', () => {
    const idx = buildHitIndex([taskA], scales);
    const midX = barLeftA + 10;
    const zone = idx.query(midX, barTopA + 5, false);
    expect(zone).not.toBeNull();
    expect(zone!.barLeft).toBeCloseTo(barLeftA, 1);
    expect(zone!.barRight).toBeCloseTo(barRightA, 1);
    expect(zone!.barTop).toBe(barTopA);
    expect(zone!.barBottom).toBe(barBottomA);
  });
});
