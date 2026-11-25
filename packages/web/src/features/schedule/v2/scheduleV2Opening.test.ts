import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import {
  capChildren,
  gridFooterText,
  gridWarnings,
  openingExpandedIds,
  openingWindow,
  shiftIso,
} from './scheduleV2Opening';

const t = (over: Partial<Task> & { id: string }): Task =>
  ({ name: over.id, isSummary: false, parentId: null, status: 'NOT_STARTED', ...over }) as Task;

describe('openingWindow', () => {
  it('fits 12 weeks and starts the window 16 days before today', () => {
    const w = openingWindow('2026-06-15', 840);
    expect(w.pxPerDay).toBe(10);
    // centered 42 days into the window: left edge = today - 16d, today at 19%
    expect(w.centerIso).toBe(shiftIso('2026-06-15', 26));
    expect(16 / 84).toBeLessThan(0.2);
  });
});

describe('openingExpandedIds', () => {
  const tasks = [
    t({ id: 'a', isSummary: true, start: '2026-01-01', finish: '2026-02-01' }),
    t({ id: 'b', isSummary: true, start: '2026-06-01', finish: '2026-07-01' }),
    t({ id: 'b1', isSummary: true, parentId: 'b' }),
    t({ id: 'c', isSummary: true, start: '2026-08-01', finish: '2026-09-01' }),
  ];
  it('opens only the phase containing today, with its nested summaries', () => {
    expect(openingExpandedIds(tasks, '2026-06-15')).toEqual(['b', 'b1']);
  });
  it('falls back to the first unfinished phase when today is in none', () => {
    expect(openingExpandedIds(tasks, '2027-01-01')).toEqual(['a']);
  });
  it('does not match a phase with a missing start or finish as containing today', () => {
    const open = [
      t({ id: 'a', isSummary: true, start: '2026-01-01', finish: '2026-02-01', progress: 100 }),
      t({ id: 'b', isSummary: true, start: '2026-06-01', progress: 50 }),
      t({ id: 'b1', isSummary: true, parentId: 'b' }),
      t({ id: 'c', isSummary: true, finish: '2026-09-01', progress: 0 }),
    ];
    // Neither b nor c can contain today, so the first unfinished phase opens.
    expect(openingExpandedIds(open, '2026-06-15')).toEqual(['b', 'b1']);
  });
  it('returns nothing without phases', () => {
    expect(openingExpandedIds([t({ id: 'x' })], '2026-06-15')).toEqual([]);
  });
});

describe('capChildren', () => {
  const rows = [
    { id: 'p', parentId: null as string | null },
    ...Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, parentId: 'p' as string | null })),
    { id: 'g', parentId: 'c12' as string | null },
  ];
  const parentOf = (r: { parentId: string | null }) => r.parentId;
  it('keeps 10 children, hides the rest and their descendants, and counts them', () => {
    const r = capChildren(rows, parentOf, new Set());
    expect(r.rows.map((x) => x.id)).toEqual([
      'p',
      ...Array.from({ length: 10 }, (_, i) => `c${i}`),
    ]);
    expect(r.hiddenByParent.get('p')).toBe(3);
  });
  it('shows everything once the parent is revealed', () => {
    const r = capChildren(rows, parentOf, new Set(['p']));
    expect(r.rows).toHaveLength(rows.length);
    expect(r.hiddenByParent.size).toBe(0);
  });
});

describe('capChildren exemption', () => {
  const rows = [
    { id: 'p', parentId: null as string | null },
    ...Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, parentId: 'p' as string | null })),
  ];
  it('keeps an exempt row past the cap without revealing its siblings', () => {
    const r = capChildren(rows, (x) => x.parentId, new Set(), undefined, new Set(['p', 'c11']));
    const ids = r.rows.map((x) => x.id);
    expect(ids).toContain('c11');
    expect(ids).not.toContain('c10');
    expect(r.hiddenByParent.get('p')).toBe(2);
  });
});

describe('gridWarnings', () => {
  const rows = [
    t({ id: '1', status: 'IN_PROGRESS' }),
    t({ id: '2', status: 'IN_PROGRESS', plannedStart: '2026-01-01' }),
    t({ id: '3', blockedReason: 'waiting on vendor' }),
    t({ id: 's', isSummary: true, status: 'IN_PROGRESS' }),
  ];
  it('counts leaf tasks, blocked, and no-committed-start; ignores summaries', () => {
    expect(gridWarnings(rows)).toEqual({ total: 3, noCommittedStart: 1, blocked: 1 });
  });
  it('prints only non-zero warnings in the footer', () => {
    expect(gridFooterText({ total: 3, noCommittedStart: 1, blocked: 1 })).toBe(
      '3 tasks · 1 blocked',
    );
    expect(gridFooterText({ total: 1, noCommittedStart: 0, blocked: 0 })).toBe('1 task');
  });
});
