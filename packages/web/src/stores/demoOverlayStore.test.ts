import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyDemoOverlay,
  useDemoOverlayStore,
  DEMO_OVERLAY_CAP,
  type DemoOverlayEntry,
} from './demoOverlayStore';
import type { Task } from '@/types';

function task(id: string, start: string, finish: string, duration = 5): Task {
  return { id, name: id, start, finish, duration } as Task;
}

describe('useDemoOverlayStore', () => {
  beforeEach(() => {
    useDemoOverlayStore.getState().clear();
  });

  it('last write wins for the same task id', () => {
    const { set } = useDemoOverlayStore.getState();
    set('t1', { start: '2026-01-05', finish: '2026-01-09' });
    set('t1', { start: '2026-01-12', finish: '2026-01-16' });
    const entries = useDemoOverlayStore.getState().entries;
    expect(entries.size).toBe(1);
    expect(entries.get('t1')).toEqual({ start: '2026-01-12', finish: '2026-01-16' });
  });

  it('keeps both entries when two different bars are dragged', () => {
    const { set } = useDemoOverlayStore.getState();
    set('t1', { start: '2026-01-05' });
    set('t2', { start: '2026-02-05' });
    const entries = useDemoOverlayStore.getState().entries;
    expect(entries.size).toBe(2);
    expect(entries.get('t1')?.start).toBe('2026-01-05');
    expect(entries.get('t2')?.start).toBe('2026-02-05');
  });

  it('evicts the oldest entry at the cap', () => {
    const { set } = useDemoOverlayStore.getState();
    for (let i = 0; i < DEMO_OVERLAY_CAP + 3; i += 1) {
      set(`t${i}`, { start: '2026-01-05' });
    }
    const entries = useDemoOverlayStore.getState().entries;
    expect(entries.size).toBe(DEMO_OVERLAY_CAP);
    expect(entries.has('t0')).toBe(false);
    expect(entries.has('t2')).toBe(false);
    expect(entries.has('t3')).toBe(true);
    expect(entries.has(`t${DEMO_OVERLAY_CAP + 2}`)).toBe(true);
  });

  it('re-dragging an existing bar moves it to the newest end of the eviction order', () => {
    const { set } = useDemoOverlayStore.getState();
    for (let i = 0; i < DEMO_OVERLAY_CAP; i += 1) set(`t${i}`, { start: '2026-01-05' });
    // Touch the oldest, then push one past the cap: the touched bar must survive.
    set('t0', { start: '2026-03-05' });
    set('overflow', { start: '2026-01-05' });
    const entries = useDemoOverlayStore.getState().entries;
    expect(entries.get('t0')?.start).toBe('2026-03-05');
    expect(entries.has('t1')).toBe(false);
  });
});

describe('applyDemoOverlay', () => {
  const tasks = [task('t1', '2026-01-05', '2026-01-09'), task('t2', '2026-02-02', '2026-02-06')];

  it('returns the input untouched when the overlay is empty', () => {
    const out = applyDemoOverlay(tasks, new Map());
    expect(out).toBe(tasks);
  });

  it('returns undefined for undefined tasks', () => {
    expect(applyDemoOverlay(undefined, new Map([['t1', { start: 'x' }]]))).toBeUndefined();
  });

  it('overlays only the named task, and only the fields the entry carries', () => {
    const overlay = new Map<string, DemoOverlayEntry>([['t1', { start: '2026-01-19' }]]);
    const out = applyDemoOverlay(tasks, overlay)!;
    expect(out[0].start).toBe('2026-01-19');
    // finish and duration untouched — the entry did not carry them.
    expect(out[0].finish).toBe('2026-01-09');
    expect(out[0].duration).toBe(5);
    expect(out[1]).toEqual(tasks[1]);
  });

  it('never reorders rows', () => {
    const overlay = new Map<string, DemoOverlayEntry>([
      ['t2', { start: '2025-01-01', finish: '2025-01-02' }],
    ]);
    const out = applyDemoOverlay(tasks, overlay)!;
    expect(out.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});
