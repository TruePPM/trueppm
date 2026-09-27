/**
 * #4079 — a work-driven milestone sits at the END of its shown day.
 *
 * The engine makes a zero-duration milestone an instant: `A(Mon..Fri) -FS-> M`
 * shows M on Friday, meaning the close of Friday. The Gantt used to draw every
 * diamond at the START of its day, so M sat on top of A's last day and the FS
 * arrow into it ran backward. These tests pin every x-position the schedule
 * derives for a diamond — the paint, the arrow anchors, the routing obstacle
 * and the hit zone — to the one rule: a work-driven diamond's center is the
 * right edge of its predecessor's last day; a floor-held one's is the left
 * edge of its day.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Task, TaskLink } from '@/types';
import { buildScaleData, dateToLeft, dateToRight, milestoneX } from './GanttScaleData';
import { drawMilestone, prepareDependencyLayout } from './GanttRenderer';
import { buildHitIndex } from './GanttHitIndex';
import { barExtent } from '../export/scheduleArrowGeometry';
import type { SchedulePrintRow } from '../export/schedulePrintData';

const SCALES = buildScaleData('week', '2026-01-01', '2026-02-01');

function task(overrides: Partial<Task>): Task {
  return {
    id: 't',
    name: 't',
    start: '2026-01-05',
    finish: '2026-01-05',
    plannedStart: '2026-01-05',
    duration: 1,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'NOT_STARTED',
    assignees: [],
    notes: '',
    wbs: '1',
    ...overrides,
  } as Task;
}

/** A: Mon 01-05 .. Fri 01-09. M: shown Fri 01-09, at the end of it. */
const A = task({ id: 'A', start: '2026-01-05', finish: '2026-01-09', duration: 5 });
const M_END = task({
  id: 'M',
  start: '2026-01-09',
  finish: '2026-01-09',
  plannedStart: '2026-01-05',
  duration: 0,
  isMilestone: true,
  milestoneAtDayEnd: true,
  wbs: '2',
});
/** Held by the project-start floor: the start of Mon 01-05. */
const M_START = task({
  id: 'K',
  start: '2026-01-05',
  finish: '2026-01-05',
  duration: 0,
  isMilestone: true,
  milestoneAtDayEnd: false,
  wbs: '0',
});

const A_RIGHT = dateToRight(A.finish, SCALES);

function diamondCenterX(t: Task): number {
  const translates: number[][] = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn((x: number, y: number) => translates.push([x, y])),
    rotate: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
  drawMilestone(ctx, t, 0, SCALES, 0, false);
  expect(translates).toHaveLength(1);
  return translates[0][0];
}

describe('milestoneX (#4079)', () => {
  it('is the right edge of the shown day at the end of the day', () => {
    expect(milestoneX('2026-01-09', true, SCALES)).toBe(dateToRight('2026-01-09', SCALES));
  });

  it('is the left edge of the shown day otherwise', () => {
    expect(milestoneX('2026-01-05', false, SCALES)).toBe(dateToLeft('2026-01-05', SCALES));
    expect(milestoneX('2026-01-05', undefined, SCALES)).toBe(dateToLeft('2026-01-05', SCALES));
  });
});

describe('drawMilestone (#4079)', () => {
  it('centers a work-driven diamond on the right edge of its predecessor', () => {
    expect(diamondCenterX(M_END)).toBe(A_RIGHT);
  });

  it('centers a floor-held diamond on the left edge of its day', () => {
    expect(diamondCenterX(M_START)).toBe(dateToLeft('2026-01-05', SCALES));
  });
});

describe('dependency layout (#4079)', () => {
  const links: TaskLink[] = [{ id: 'l1', sourceId: 'A', targetId: 'M', type: 'FS' } as TaskLink];
  const layout = prepareDependencyLayout([A, M_END], links, SCALES);
  const halfDiag = Math.ceil((12 / 2) * Math.SQRT2);

  it('anchors an FS arrow into the milestone after the predecessor ends, not before', () => {
    const m = layout.nodes.get('M');
    const a = layout.nodes.get('A');
    expect(m).toBeDefined();
    expect(a).toBeDefined();
    // The arrow leaves A's right edge and enters M's left vertex, which is the
    // diamond center less its half-diagonal: forward, never backward.
    expect(a?.barRight).toBe(A_RIGHT);
    expect(m?.barLeft).toBe(A_RIGHT - halfDiag);
    expect(m?.barRight).toBe(A_RIGHT + halfDiag);
  });

  it('centers the milestone obstacle box on the diamond', () => {
    const box = layout.barByRow[1];
    expect(box).toBeDefined();
    expect((box?.x ?? 0) + (box?.width ?? 0) / 2).toBe(A_RIGHT);
  });
});

describe('hit index (#4079)', () => {
  it('starts a work-driven milestone zone at its diamond center', () => {
    const geom = buildHitIndex([A, M_END], SCALES).rowGeometry(1);
    expect(geom?.barLeft).toBe(A_RIGHT);
    // The diamond itself is hittable — no longer covered only by A's last day.
    const zone = buildHitIndex([A, M_END], SCALES).query(
      A_RIGHT + 1,
      (geom!.barTop + geom!.barBottom) / 2,
      false,
    );
    expect(zone?.taskId).toBe('M');
  });

  it('keeps a floor-held milestone zone at the start of its day', () => {
    const geom = buildHitIndex([M_START], SCALES).rowGeometry(0);
    expect(geom?.barLeft).toBe(dateToLeft('2026-01-05', SCALES));
  });
});

describe('print export arrow geometry (#4079)', () => {
  function row(overrides: Partial<SchedulePrintRow>): SchedulePrintRow {
    return {
      id: 'M',
      start: '2026-01-09',
      finish: '2026-01-09',
      isMilestone: true,
      ...overrides,
    } as SchedulePrintRow;
  }

  it('centers an end-of-day milestone on the right edge of its day', () => {
    const ext = barExtent(row({ milestoneAtDayEnd: true }), SCALES);
    expect((ext.left + ext.right) / 2).toBe(A_RIGHT);
  });

  it('centers a start-of-day milestone on the left edge of its day', () => {
    const ext = barExtent(row({ start: '2026-01-05', finish: '2026-01-05' }), SCALES);
    expect((ext.left + ext.right) / 2).toBe(dateToLeft('2026-01-05', SCALES));
  });
});
