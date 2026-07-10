import { describe, it, expect } from 'vitest';
import type { Task } from '@/types';
import {
  barGeometry,
  compareWbs,
  computeScheduleWindow,
  markerLeftPct,
  todayLeftPct,
  wbsDepth,
} from './mobileScheduleGeometry';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't',
    wbs: '1',
    name: 'Task',
    start: '2026-01-01',
    finish: '2026-01-11',
    duration: 10,
    progress: 0,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

describe('compareWbs', () => {
  it('orders numerically, not lexically ("1.10" after "1.2")', () => {
    const sorted = ['1.10', '1.2', '1', '2', '1.1'].sort(compareWbs);
    expect(sorted).toEqual(['1', '1.1', '1.2', '1.10', '2']);
  });

  it('treats missing segments as zero', () => {
    expect(compareWbs('1', '1.1')).toBeLessThan(0);
    expect(compareWbs('', '1')).toBeLessThan(0);
  });
});

describe('wbsDepth', () => {
  it('is the number of dot separators', () => {
    expect(wbsDepth('1')).toBe(0);
    expect(wbsDepth('1.2')).toBe(1);
    expect(wbsDepth('1.2.3')).toBe(2);
  });

  it('caps deep nesting so indent never eats the row', () => {
    expect(wbsDepth('1.2.3.4.5.6')).toBe(4);
  });
});

describe('computeScheduleWindow', () => {
  it('spans the earliest start to the latest finish', () => {
    const w = computeScheduleWindow([
      task({ start: '2026-01-01', finish: '2026-01-05' }),
      task({ start: '2026-01-03', finish: '2026-01-20' }),
    ]);
    expect(w).not.toBeNull();
    expect(w!.startMs).toBe(Date.parse('2026-01-01'));
    expect(w!.endMs).toBe(Date.parse('2026-01-20'));
    expect(w!.spanMs).toBe(Date.parse('2026-01-20') - Date.parse('2026-01-01'));
  });

  it('returns null when no task has parseable dates', () => {
    expect(computeScheduleWindow([task({ start: '', finish: '' })])).toBeNull();
    expect(computeScheduleWindow([])).toBeNull();
  });
});

describe('barGeometry', () => {
  const window = computeScheduleWindow([task({ start: '2026-01-01', finish: '2026-01-11' })])!;

  it('places a full-window task at 0%/100%', () => {
    const g = barGeometry(task({ start: '2026-01-01', finish: '2026-01-11' }), window);
    expect(g.leftPct).toBeCloseTo(0);
    expect(g.widthPct).toBeCloseTo(100);
  });

  it('places a mid-window task proportionally', () => {
    // Jan 6 is halfway across a Jan 1 → Jan 11 window.
    const g = barGeometry(task({ start: '2026-01-06', finish: '2026-01-11' }), window);
    expect(g.leftPct).toBeCloseTo(50, 0);
    expect(g.widthPct).toBeCloseTo(50, 0);
  });

  it('floors a zero-length bar to a visible sliver', () => {
    const g = barGeometry(task({ start: '2026-01-06', finish: '2026-01-06' }), window);
    expect(g.widthPct).toBeGreaterThanOrEqual(0.75);
  });

  it('never overflows the track (left + width ≤ 100)', () => {
    const g = barGeometry(task({ start: '2026-01-10', finish: '2027-01-01' }), window);
    expect(g.leftPct + g.widthPct).toBeLessThanOrEqual(100.0001);
  });

  it('is full-width when the window has zero span', () => {
    const flat = computeScheduleWindow([task({ start: '2026-01-01', finish: '2026-01-01' })]);
    const g = barGeometry(task({ start: '2026-01-01', finish: '2026-01-01' }), flat);
    expect(g).toEqual({ leftPct: 0, widthPct: 100 });
  });
});

describe('markerLeftPct', () => {
  const window = computeScheduleWindow([task({ start: '2026-01-01', finish: '2026-01-11' })])!;

  it('positions a milestone at its start', () => {
    expect(markerLeftPct(task({ start: '2026-01-06', finish: '2026-01-06' }), window)).toBeCloseTo(
      50,
      0,
    );
  });
});

describe('todayLeftPct', () => {
  const window = computeScheduleWindow([task({ start: '2026-01-01', finish: '2026-01-11' })])!;

  it('positions today inside the window', () => {
    expect(todayLeftPct(window, Date.parse('2026-01-06'))).toBeCloseTo(50, 0);
  });

  it('returns null when today is outside the window', () => {
    expect(todayLeftPct(window, Date.parse('2025-06-01'))).toBeNull();
    expect(todayLeftPct(window, Date.parse('2027-06-01'))).toBeNull();
  });
});
