import { describe, it, expect, beforeEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import {
  applyDemoOverlay,
  captureDemoOverlayEntry,
  useDemoOverlayStore,
  DEMO_OVERLAY_CAP,
  type DemoOverlayEntry,
} from './demoOverlayStore';
import { queryClient as appQueryClient } from '@/lib/queryClient';
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

  // ADR-1198 (#3967) — the board card's dropped column.
  it('overlays status without disturbing the row it sits on', () => {
    const overlay = new Map<string, DemoOverlayEntry>([['t1', { status: 'COMPLETE' }]]);
    const out = applyDemoOverlay(tasks, overlay)!;
    expect(out[0].status).toBe('COMPLETE');
    // A status overlay is a status overlay — the dates it did not carry stand.
    expect(out[0].start).toBe('2026-01-05');
    expect(out[1]).toEqual(tasks[1]);
  });

  it('does NOT infer progress or completion from a DONE status', () => {
    // `optimisticStatusPatch` — the client's own standing belief about a status
    // move — carries status and nothing else, and the server fills the rest in on a
    // real install. Fabricating them here would make the demo board the only surface
    // in the product computing a completion percentage without a server.
    const withProgress = [{ ...tasks[0], progress: 40, isComplete: false } as Task];
    const overlay = new Map<string, DemoOverlayEntry>([['t1', { status: 'COMPLETE' }]]);
    const out = applyDemoOverlay(withProgress, overlay)!;
    expect(out[0].progress).toBe(40);
    expect(out[0].isComplete).toBe(false);
  });

  it('carries dates and status together when one entry holds both', () => {
    const overlay = new Map<string, DemoOverlayEntry>([
      ['t1', { start: '2026-01-19', status: 'IN_PROGRESS' }],
    ]);
    const out = applyDemoOverlay(tasks, overlay)!;
    expect(out[0].start).toBe('2026-01-19');
    expect(out[0].status).toBe('IN_PROGRESS');
  });
});

describe('captureDemoOverlayEntry — the shared both-facts gate (ADR-1198)', () => {
  beforeEach(() => {
    useDemoOverlayStore.getState().clear();
    appQueryClient.removeQueries({ queryKey: ['edition'] });
  });

  function make403(data: Record<string, unknown>) {
    const err = new AxiosError('Request failed with status code 403');
    err.config = { headers: new AxiosHeaders() };
    err.response = {
      status: 403,
      data,
      statusText: '',
      headers: {},
      config: err.config,
    } as AxiosError['response'];
    return err;
  }

  const demo403 = () => make403({ detail: 'read-only demo', code: 'demo_read_only' });

  it('captures when the deployment is a demo AND the refusal is the mode’s own', () => {
    appQueryClient.setQueryData(['edition'], { edition: 'community', demo_read_only: true });
    expect(captureDemoOverlayEntry(demo403(), 't1', { status: 'COMPLETE' })).toBe(true);
    expect(useDemoOverlayStore.getState().entries.get('t1')).toEqual({ status: 'COMPLETE' });
  });

  it('declines a demo-coded 403 on a deployment that is not a demo', () => {
    appQueryClient.setQueryData(['edition'], { edition: 'community', demo_read_only: false });
    expect(captureDemoOverlayEntry(demo403(), 't1', { status: 'COMPLETE' })).toBe(false);
    expect(useDemoOverlayStore.getState().entries.size).toBe(0);
  });

  it('declines when the edition cache has not resolved — the safe default', () => {
    expect(captureDemoOverlayEntry(demo403(), 't1', { status: 'COMPLETE' })).toBe(false);
    expect(useDemoOverlayStore.getState().entries.size).toBe(0);
  });

  it('declines an ordinary 403 even inside the demo', () => {
    appQueryClient.setQueryData(['edition'], { edition: 'community', demo_read_only: true });
    expect(captureDemoOverlayEntry(make403({ detail: 'Not permitted.' }), 't1', {
      status: 'COMPLETE',
    })).toBe(false);
    expect(useDemoOverlayStore.getState().entries.size).toBe(0);
  });

  it('reports false for an empty entry rather than pinning a no-op preview', () => {
    // Reporting `true` here would tell the caller a preview is on screen when none is,
    // and the caller would then swallow its own failure affordance.
    appQueryClient.setQueryData(['edition'], { edition: 'community', demo_read_only: true });
    expect(captureDemoOverlayEntry(demo403(), 't1', {})).toBe(false);
    expect(useDemoOverlayStore.getState().entries.size).toBe(0);
  });
});
