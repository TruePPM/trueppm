import { describe, it, expect } from 'vitest';
import {
  buildSchedulePrintData,
  compareWbs,
  classifyLinkHardness,
  scheduleContentSha,
  MAX_INDENT_LEVELS,
  type BuildSchedulePrintArgs,
} from './schedulePrintData';
import type { Task, TaskLink, MonteCarloResult } from '@/types';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    wbs: id,
    name: `Task ${id}`,
    start: '2026-04-01',
    finish: '2026-04-05',
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
    ...overrides,
  } as Task;
}

function link(id: string, overrides: Partial<TaskLink> = {}): TaskLink {
  return {
    id,
    sourceId: 'a',
    targetId: 'b',
    type: 'FS',
    lag: 0,
    isCritical: false,
    ...overrides,
  };
}

function build(overrides: Partial<BuildSchedulePrintArgs> = {}) {
  return buildSchedulePrintData({
    projectName: 'Apollo',
    tasks: [],
    links: [],
    userName: 'Jane Doe',
    generatedAtLabel: 'Jun 30, 2026 10:00',
    ...overrides,
  });
}

describe('compareWbs', () => {
  it('sorts dotted paths numerically, not lexically', () => {
    const sorted = ['1.10', '1.2', '1.1', '2', '1'].sort(compareWbs);
    expect(sorted).toEqual(['1', '1.1', '1.2', '1.10', '2']);
  });

  it('sorts a shorter prefix before its descendants', () => {
    expect(compareWbs('1', '1.1')).toBeLessThan(0);
    expect(compareWbs('1.1', '1')).toBeGreaterThan(0);
    expect(compareWbs('1.2', '1.2')).toBe(0);
  });
});

describe('classifyLinkHardness', () => {
  it('treats a zero/negative-lag FS link as hard (mandatory spine)', () => {
    expect(classifyLinkHardness(link('l', { type: 'FS', lag: 0 }))).toBe(true);
    expect(classifyLinkHardness(link('l', { type: 'FS', lag: -2 }))).toBe(true);
  });

  it('treats a positive-lag FS link as soft (discretionary buffer)', () => {
    expect(classifyLinkHardness(link('l', { type: 'FS', lag: 3 }))).toBe(false);
  });

  it('treats lateral link types as soft', () => {
    expect(classifyLinkHardness(link('l', { type: 'SS', lag: 0 }))).toBe(false);
    expect(classifyLinkHardness(link('l', { type: 'FF', lag: 0 }))).toBe(false);
    expect(classifyLinkHardness(link('l', { type: 'SF', lag: 0 }))).toBe(false);
  });
});

describe('buildSchedulePrintData — rows', () => {
  it('orders rows by WBS numerically', () => {
    const data = build({
      tasks: [task('1.10', { wbs: '1.10' }), task('1.2', { wbs: '1.2' }), task('1', { wbs: '1' })],
    });
    expect(data.rows.map((r) => r.wbsCode)).toEqual(['1', '1.2', '1.10']);
  });

  it('caps the visual indent at MAX_INDENT_LEVELS but keeps the full WBS path + depth', () => {
    const data = build({ tasks: [task('deep', { wbs: '1.2.3.4.5' })] });
    const row = data.rows[0];
    expect(row.depth).toBe(5);
    expect(row.indentLevel).toBe(MAX_INDENT_LEVELS);
    expect(row.wbsCode).toBe('1.2.3.4.5');
  });

  it('derives owner initials from the first assignee', () => {
    const data = build({
      tasks: [task('a', { assignees: [{ resourceId: 'r1', name: 'Grace Hopper', units: 1 }] })],
    });
    expect(data.rows[0].owner).toBe('Grace Hopper');
    expect(data.rows[0].ownerInitials).toBe('GH');
  });

  it('classifies kind as phase / milestone / task', () => {
    const data = build({
      tasks: [
        task('p', { wbs: '1', isSummary: true }),
        task('m', { wbs: '2', isMilestone: true }),
        task('t', { wbs: '3' }),
      ],
    });
    expect(data.rows.map((r) => r.kind)).toEqual(['phase', 'milestone', 'task']);
  });

  it('marks a milestone met when complete or 100% progress', () => {
    const data = build({
      tasks: [
        task('m1', { wbs: '1', isMilestone: true, isComplete: true }),
        task('m2', { wbs: '2', isMilestone: true, progress: 100 }),
        task('m3', { wbs: '3', isMilestone: true, progress: 40 }),
      ],
    });
    expect(data.rows.map((r) => r.milestoneMet)).toEqual([true, true, false]);
  });
});

describe('buildSchedulePrintData — risk band', () => {
  it('ranks critical-path membership highest', () => {
    const data = build({ tasks: [task('a', { isCritical: true, totalFloat: 5 })] });
    expect(data.rows[0].riskBand).toBe('critical');
  });

  it('flags at-risk on negative float, a behind/at_risk SPI band, or positive variance', () => {
    const data = build({
      tasks: [
        task('neg', { wbs: '1', totalFloat: -1 }),
        task('spi', { wbs: '2', spiBand: 'behind' }),
        task('var', { wbs: '3', scheduleVarianceDays: 2 }),
      ],
    });
    expect(data.rows.every((r) => r.riskBand === 'at-risk')).toBe(true);
  });

  it('defaults to on-track when no risk signal is present', () => {
    const data = build({ tasks: [task('a', { totalFloat: 4, spiBand: 'on_track' })] });
    expect(data.rows[0].riskBand).toBe('on-track');
  });
});

describe('buildSchedulePrintData — links', () => {
  it('maps source/target ids and hard/soft, dropping dangling links', () => {
    const data = build({
      tasks: [task('a', { wbs: '1' }), task('b', { wbs: '2' })],
      links: [
        link('keep', { sourceId: 'a', targetId: 'b', type: 'FS', lag: 0 }),
        link('soft', { sourceId: 'a', targetId: 'b', type: 'SS', lag: 0 }),
        link('dangling', { sourceId: 'a', targetId: 'ghost' }),
      ],
    });
    expect(data.links.map((l) => l.id)).toEqual(['keep', 'soft']);
    expect(data.links.find((l) => l.id === 'keep')?.hard).toBe(true);
    expect(data.links.find((l) => l.id === 'soft')?.hard).toBe(false);
    expect(data.links.find((l) => l.id === 'keep')?.fromId).toBe('a');
    expect(data.links.find((l) => l.id === 'keep')?.toId).toBe('b');
  });
});

describe('buildSchedulePrintData — KPIs', () => {
  it('computes the project window and inclusive duration', () => {
    const data = build({
      tasks: [
        task('a', { wbs: '1', start: '2026-04-01', finish: '2026-04-05' }),
        task('b', { wbs: '2', start: '2026-04-03', finish: '2026-04-10' }),
      ],
    });
    expect(data.kpis.window.value).toContain('–');
    expect(data.kpis.window.sub).toBe('10d'); // Apr 1 → Apr 10 inclusive
  });

  it('counts critical-path tasks and reports the minimum float', () => {
    const data = build({
      tasks: [
        task('a', { wbs: '1', isCritical: true, totalFloat: 0 }),
        task('b', { wbs: '2', isCritical: true, totalFloat: -1 }),
        task('c', { wbs: '3', isCritical: false }),
      ],
    });
    expect(data.kpis.criticalPath.value).toBe('2 tasks');
    expect(data.kpis.criticalPath.sub).toBe('-1d float');
  });

  it('averages progress over leaf rows only and counts done', () => {
    const data = build({
      tasks: [
        task('phase', { wbs: '1', isSummary: true, progress: 100 }),
        task('a', { wbs: '1.1', progress: 100 }),
        task('b', { wbs: '1.2', progress: 0 }),
      ],
    });
    expect(data.kpis.progress.value).toBe('50%');
    expect(data.kpis.progress.sub).toBe('1 / 2 done');
  });

  it('summarizes milestones met and the next due date', () => {
    const data = build({
      tasks: [
        task('m1', { wbs: '1', isMilestone: true, isComplete: true }),
        task('m2', { wbs: '2', isMilestone: true, progress: 0, finish: '2026-05-01' }),
      ],
    });
    expect(data.kpis.milestones.value).toBe('1 / 2 met');
    expect(data.kpis.milestones.sub).toContain('next');
  });

  it('renders the forecast P80 and signed slip vs CPM when a forecast is supplied', () => {
    const forecast: MonteCarloResult = {
      projectId: 'p',
      runs: 1000,
      p50: '2026-05-10',
      p80: '2026-05-20',
      p95: '2026-05-30',
      buckets: [],
      cpmFinish: '2026-05-15',
      deltaVsCpm: { p50: null, p80: 5, p95: null },
      confidenceCurve: [],
      sensitivity: [],
    };
    const data = build({ forecast, tasks: [task('a')] });
    expect(data.kpis.forecastP80.value).not.toBe('—');
    expect(data.kpis.forecastP80.sub).toBe('+5d vs CPM');
  });

  it('falls back to em-dash forecast when no Monte-Carlo result exists', () => {
    const data = build({ tasks: [task('a')] });
    expect(data.kpis.forecastP80.value).toBe('—');
    expect(data.kpis.forecastP80.sub).toBeNull();
  });
});

describe('buildSchedulePrintData — critical-path chain', () => {
  it('orders CP-member rows by start then assigns 1-based sequence', () => {
    const data = build({
      tasks: [
        task('late', { wbs: '3', isCritical: true, start: '2026-04-10', finish: '2026-04-12' }),
        task('early', { wbs: '1', isCritical: true, start: '2026-04-01', finish: '2026-04-03' }),
        task('mid', { wbs: '2', isCritical: true, start: '2026-04-05', finish: '2026-04-07' }),
        task('off', { wbs: '4', isCritical: false }),
      ],
    });
    expect(data.cpChain.map((t) => t.id)).toEqual(['early', 'mid', 'late']);
    expect(data.cpChain.map((t) => t.seq)).toEqual([1, 2, 3]);
  });
});

describe('buildSchedulePrintData — masthead & footer', () => {
  it('defaults the method subtitle and passes through context', () => {
    const data = build({ orgName: 'NASA', projectKey: 'APOLLO', contentSha: 'abc123' });
    expect(data.masthead.methodSubtitle).toContain('Critical Path');
    expect(data.masthead.orgName).toBe('NASA');
    expect(data.footer.userName).toBe('Jane Doe');
    expect(data.footer.contentSha).toBe('abc123');
    expect(data.footer.signOff).toContain('CPM engine');
  });

  it('passes the workspace URL through to the masthead', () => {
    const data = build({ workspaceUrl: 'https://ppm.example.com' });
    expect(data.masthead.workspaceUrl).toBe('https://ppm.example.com');
  });

  it('derives an 8-hex content fingerprint when none is supplied', () => {
    const data = build({ tasks: [task('a', { start: '2026-04-01', finish: '2026-04-05' })] });
    expect(data.footer.contentSha).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('scheduleContentSha', () => {
  const cfg = () => ({
    tasks: [
      task('a', { wbs: '1', start: '2026-04-01', finish: '2026-04-08', isCritical: true }),
      task('b', { wbs: '2', start: '2026-04-09', finish: '2026-04-20', progress: 40 }),
    ],
  });

  it('is deterministic for identical schedule state', () => {
    expect(build(cfg()).footer.contentSha).toBe(build(cfg()).footer.contentSha);
  });

  it('shifts when a task finish date changes', () => {
    const a = build(cfg()).footer.contentSha;
    const moved = build({
      tasks: [
        task('a', { wbs: '1', start: '2026-04-01', finish: '2026-04-08', isCritical: true }),
        task('b', { wbs: '2', start: '2026-04-09', finish: '2026-04-30', progress: 40 }),
      ],
    }).footer.contentSha;
    expect(moved).not.toBe(a);
  });

  it('shifts when link hardness changes', () => {
    const tasks = [task('a', { wbs: '1' }), task('b', { wbs: '2' })];
    const hard = build({ tasks, links: [link('l', { type: 'FS', lag: 0 })] }).footer.contentSha;
    const soft = build({ tasks, links: [link('l', { type: 'FS', lag: 3 })] }).footer.contentSha;
    expect(hard).not.toBe(soft);
  });

  it('exposes the same hex via the standalone helper as via the built footer', () => {
    const data = build(cfg());
    expect(scheduleContentSha(data.rows, data.links, data.kpis)).toBe(data.footer.contentSha);
  });
});

describe('buildSchedulePrintData — issue 1438 chart filters', () => {
  const A = task('a', { wbs: '1', start: '2026-04-01', finish: '2026-04-08', isCritical: true });
  const B = task('b', { wbs: '2', start: '2026-04-20', finish: '2026-04-30', isCritical: false });
  const UNDATED = task('u', { wbs: '3', start: undefined, finish: undefined, isCritical: false });

  it('criticalOnly charts only critical rows but leaves KPIs/CP-chain over the full set', () => {
    const full = build({ tasks: [A, B] });
    const filtered = build({ tasks: [A, B], criticalOnly: true });
    expect(filtered.rows.map((r) => r.id)).toEqual(['a']);
    // KPIs describe the whole project regardless of the chart declutter.
    expect(filtered.kpis).toEqual(full.kpis);
    expect(filtered.cpChain).toEqual(full.cpChain);
  });

  it('windowStart/windowEnd keeps only rows overlapping the window and drops undated rows', () => {
    const data = build({
      tasks: [A, B, UNDATED],
      windowStart: '2026-04-15',
      windowEnd: '2026-05-01',
    });
    // A (Apr 1–8) is out of the window; B (Apr 20–30) overlaps; undated dropped.
    expect(data.rows.map((r) => r.id)).toEqual(['b']);
  });

  it('window overlap is inclusive at the boundary (row finishing on windowStart is kept)', () => {
    const boundary = task('x', { wbs: '1', start: '2026-04-01', finish: '2026-04-15' });
    const data = build({ tasks: [boundary], windowStart: '2026-04-15', windowEnd: '2026-04-30' });
    expect(data.rows.map((r) => r.id)).toEqual(['x']);
  });

  it('prunes links whose endpoint fell outside the window', () => {
    const data = build({
      tasks: [A, B],
      links: [link('l', { sourceId: 'a', targetId: 'b', type: 'FS', lag: 0 })],
      windowStart: '2026-04-18',
      windowEnd: '2026-05-01',
    });
    // Only B survives the window, so the a→b link has a missing endpoint and prunes.
    expect(data.rows.map((r) => r.id)).toEqual(['b']);
    expect(data.links).toEqual([]);
  });

  it('is unchanged from the pre-1438 behavior when no filters are passed', () => {
    const data = build({ tasks: [A, B] });
    expect(data.rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
