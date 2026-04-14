import { describe, it, expect, vi } from 'vitest';
import { drawSummaryBar, MILESTONE_SIZE } from './GanttRenderer';
import { buildScaleData, dateToLeft } from './GanttScaleData';
import type { Task } from '@/types';

function makeCtxSpy() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string) =>
    vi.fn((...args: unknown[]) => {
      calls.push({ name, args });
    });
  const ctx = {
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    rotate: record('rotate'),
    beginPath: record('beginPath'),
    rect: record('rect'),
    roundRect: record('roundRect'),
    fill: record('fill'),
    stroke: record('stroke'),
    fillRect: record('fillRect'),
    set fillStyle(_v: string) {},
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const SUMMARY_TASK: Task = {
  id: 's1',
  name: 'Rollup',
  start: '2026-04-06',
  finish: '2026-04-10',
  duration: 5,
  progress: 0,
  isSummary: true,
  isMilestone: false,
  isCritical: false,
  parentId: null,
  wbs: '1',
} as unknown as Task;

describe('drawSummaryBar — diamond end-caps (#71)', () => {
  const scales = buildScaleData('week', '2026-04-01', '2026-05-01');

  it('renders diamond end-caps at both the start and finish x-coordinates', () => {
    const { ctx, calls } = makeCtxSpy();
    drawSummaryBar(ctx, SUMMARY_TASK, 0, scales, 0, false);

    const translates = calls.filter((c) => c.name === 'translate');
    const rotates = calls.filter((c) => c.name === 'rotate');

    // Two diamond caps → two translate+rotate pairs
    expect(translates.length).toBe(2);
    expect(rotates.length).toBe(2);
    for (const r of rotates) expect(r.args[0]).toBeCloseTo(Math.PI / 4);

    const expectedLeft = dateToLeft(SUMMARY_TASK.start, scales);
    const expectedRight = dateToLeft(SUMMARY_TASK.finish, scales);
    const xs = translates.map((t) => t.args[0] as number).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(expectedLeft);
    expect(xs[1]).toBeCloseTo(expectedRight);
  });

  it('diamond cap is a MILESTONE_SIZE square drawn from (-half, -half)', () => {
    const { ctx, calls } = makeCtxSpy();
    drawSummaryBar(ctx, SUMMARY_TASK, 0, scales, 0, false);

    // Look for rect calls matching milestone geometry (not the roundRect body)
    const rects = calls.filter((c) => c.name === 'rect');
    expect(rects.length).toBe(2);
    for (const r of rects) {
      expect(r.args[0]).toBe(-MILESTONE_SIZE / 2);
      expect(r.args[1]).toBe(-MILESTONE_SIZE / 2);
      expect(r.args[2]).toBe(MILESTONE_SIZE);
      expect(r.args[3]).toBe(MILESTONE_SIZE);
    }
  });

  it('no bracket-tail fillRects remain (regression guard)', () => {
    const { ctx, calls } = makeCtxSpy();
    drawSummaryBar(ctx, SUMMARY_TASK, 0, scales, 0, false);
    expect(calls.filter((c) => c.name === 'fillRect').length).toBe(0);
  });
});
