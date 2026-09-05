import { describe, it, expect } from 'vitest';
import {
  buildSchedulePrintData,
  compareWbs,
  classifyLinkHardness,
  isRowOverdue,
  orderLinksForPaint,
  labelIndentPx,
  scheduleContentSha,
  type SchedulePrintRow,
  MAX_INDENT_LEVELS,
  LABEL_INDENT_BASE_PX,
  LABEL_INDENT_STEP_PX,
  type SchedulePrintLink,
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

  it('treats an empty path as the shortest possible prefix (sorts first, ties with itself)', () => {
    // A task with no WBS code yet (a fresh row, or an import that lost the path)
    // must still sort deterministically instead of throwing on `''.split()`.
    expect(compareWbs('', '1')).toBeLessThan(0);
    expect(compareWbs('1', '')).toBeGreaterThan(0);
    expect(compareWbs('', '')).toBe(0);
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

  it('gives a row with no WBS code depth 0 and no indent', () => {
    const data = build({ tasks: [task('orphan', { wbs: '' })] });
    expect(data.rows[0].depth).toBe(0);
    expect(data.rows[0].indentLevel).toBe(0);
    expect(data.rows[0].wbsCode).toBe('');
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

  it('sets isBehind independently of critical so a critical-and-slipping bar can hatch', () => {
    const data = build({
      tasks: [
        // Critical AND behind: band is 'critical' (precedence), but isBehind stays true
        // so the print surface draws a red frame + hatch (ADR-0277).
        task('cb', { wbs: '1', isCritical: true, totalFloat: -2 }),
        // Critical, on schedule: no hatch.
        task('c', { wbs: '2', isCritical: true, totalFloat: 5, spiBand: 'on_track' }),
        // On-track: no hatch.
        task('ok', { wbs: '3', totalFloat: 3 }),
      ],
    });
    expect(data.rows.map((r) => [r.riskBand, r.isBehind])).toEqual([
      ['critical', true],
      ['critical', false],
      ['on-track', false],
    ]);
  });
});

describe('isRowOverdue', () => {
  const row = (o: Partial<SchedulePrintRow> = {}): SchedulePrintRow => ({
    id: 't',
    wbsCode: '1',
    depth: 1,
    indentLevel: 1,
    kind: 'task',
    name: 't',
    owner: null,
    ownerInitials: null,
    start: '2026-04-01',
    finish: '2026-04-10',
    pctComplete: 0,
    isCritical: false,
    isBehind: false,
    totalFloat: null,
    riskBand: 'on-track',
    isMilestone: false,
    milestoneMet: null,
    ...o,
  });

  it('is false when there is no data date (no "now" to be past)', () => {
    expect(isRowOverdue(row({ finish: '2026-04-10' }), null)).toBe(false);
    expect(isRowOverdue(row({ finish: '2026-04-10' }), undefined)).toBe(false);
  });

  it('marks an incomplete task whose finish is before the data date', () => {
    expect(isRowOverdue(row({ finish: '2026-04-10', pctComplete: 40 }), '2026-04-15')).toBe(true);
  });

  it('does not mark a completed task, even past its finish', () => {
    expect(isRowOverdue(row({ finish: '2026-04-10', pctComplete: 100 }), '2026-04-15')).toBe(false);
  });

  it('does not mark a task whose finish is on or after the data date', () => {
    expect(isRowOverdue(row({ finish: '2026-04-15', pctComplete: 0 }), '2026-04-15')).toBe(false);
    expect(isRowOverdue(row({ finish: '2026-04-20', pctComplete: 0 }), '2026-04-15')).toBe(false);
  });

  it('marks a pending milestone whose date has passed, but never a met one', () => {
    const ms = { isMilestone: true, finish: '2026-04-10', start: '2026-04-10' };
    expect(isRowOverdue(row({ ...ms, milestoneMet: false }), '2026-04-15')).toBe(true);
    expect(isRowOverdue(row({ ...ms, milestoneMet: true }), '2026-04-15')).toBe(false);
  });

  it('compares on the date component only (ignores a stored time)', () => {
    expect(isRowOverdue(row({ finish: '2026-04-14T23:00:00Z', pctComplete: 0 }), '2026-04-15')).toBe(
      true,
    );
  });

  it('falls back to a milestone start when it carries no finish date', () => {
    // A zero-duration milestone can arrive with only a start; it must still be
    // able to read as past-due rather than silently never flagging.
    const ms = row({ isMilestone: true, milestoneMet: false, finish: null, start: '2026-04-10' });
    expect(isRowOverdue(ms, '2026-04-15')).toBe(true);
    expect(isRowOverdue({ ...ms, start: '2026-04-20' }, '2026-04-15')).toBe(false);
  });

  it('never marks a milestone that has no date at all', () => {
    const undatedMs = row({ isMilestone: true, milestoneMet: false, finish: null, start: null });
    expect(isRowOverdue(undatedMs, '2026-04-15')).toBe(false);
  });

  it('never marks an undated task, however far past the data date', () => {
    expect(isRowOverdue(row({ finish: null, pctComplete: 0 }), '2026-12-31')).toBe(false);
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
      forecastStaleness: 'current',
      planVersion: 1,
      planVersionCurrent: 1,
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

  describe('forecast slip vs CPM', () => {
    const forecastWith = (deltaP80: number | null, hasDelta = true): MonteCarloResult =>
      ({
        projectId: 'p',
        runs: 1000,
        p50: '2026-05-10',
        p80: '2026-05-20',
        p95: '2026-05-30',
        buckets: [],
        cpmFinish: '2026-05-15',
        deltaVsCpm: hasDelta ? { p50: null, p80: deltaP80, p95: null } : null,
        confidenceCurve: [],
        sensitivity: [],
        forecastStaleness: 'current',
        planVersion: 1,
        planVersionCurrent: 1,
      }) as unknown as MonteCarloResult;

    it('renders a negative slip as an unsigned ahead-of-CPM delta', () => {
      const data = build({ forecast: forecastWith(-3), tasks: [task('a')] });
      expect(data.kpis.forecastP80.sub).toBe('-3d vs CPM');
    });

    it('renders a zero slip as "on CPM finish" rather than "+0d"', () => {
      const data = build({ forecast: forecastWith(0), tasks: [task('a')] });
      expect(data.kpis.forecastP80.sub).toBe('on CPM finish');
    });

    it('omits the slip line when the run carries no p80 delta', () => {
      const data = build({ forecast: forecastWith(null), tasks: [task('a')] });
      expect(data.kpis.forecastP80.value).not.toBe('—');
      expect(data.kpis.forecastP80.sub).toBeNull();
    });

    it('omits the slip line when the run carries no CPM comparison at all', () => {
      const data = build({ forecast: forecastWith(null, false), tasks: [task('a')] });
      expect(data.kpis.forecastP80.sub).toBeNull();
    });
  });

  it('singularizes the critical-path cell for a one-task chain', () => {
    const data = build({ tasks: [task('a', { isCritical: true, totalFloat: 0 })] });
    expect(data.kpis.criticalPath.value).toBe('1 task');
  });

  it('treats a critical row with no computed float as zero float', () => {
    // Pre-CPM rows carry totalFloat === undefined; the cell must still read a
    // number rather than "undefined d float".
    const data = build({ tasks: [task('a', { isCritical: true, totalFloat: undefined })] });
    expect(data.kpis.criticalPath.sub).toBe('0d float');
  });

  describe('the Float KPI (#3344)', () => {
    it('reports the tightest float OFF the critical path, not on it', () => {
      // The distinction is the whole slot: `criticalPath.sub` already prints the
      // minimum over the CRITICAL rows, which is ~0 by construction and warns
      // nobody. What a steering pack is missing is how close the REST of the plan
      // is to becoming critical too.
      const data = build({
        tasks: [
          task('cp', { wbs: '1', isCritical: true, totalFloat: 0 }),
          task('near', { wbs: '2', totalFloat: 2 }),
          task('slack', { wbs: '3', totalFloat: 30 }),
        ],
      });
      expect(data.kpis.criticalPath.sub).toBe('0d float');
      expect(data.kpis.float.label).toBe('Float');
      expect(data.kpis.float.value).toBe('2d');
      expect(data.kpis.float.sub).toBe('tightest of 2 off the critical path');
    });

    it('reports a NEGATIVE off-path float rather than clamping it', () => {
      const data = build({
        tasks: [
          task('cp', { wbs: '1', isCritical: true, totalFloat: 0 }),
          task('late', { wbs: '2', totalFloat: -4 }),
        ],
      });
      expect(data.kpis.float.value).toBe('-4d');
    });

    it('says "every row is critical" rather than printing a bare dash', () => {
      // Measured, and the answer is that there is no slack left anywhere. That
      // reads identically to "not measured" if both print an em-dash alone, and
      // they are opposite sheets to be handed.
      const data = build({ tasks: [task('a', { isCritical: true, totalFloat: 0 })] });
      expect(data.kpis.float.value).toBe('—');
      expect(data.kpis.float.sub).toBe('every row is critical');
    });

    it('prints a bare dash with NO sub for an empty schedule', () => {
      const data = build({ tasks: [] });
      expect(data.kpis.float.value).toBe('—');
      expect(data.kpis.float.sub).toBeNull();
    });

    it('ignores a row whose float CPM has not computed', () => {
      const data = build({
        tasks: [task('n', { wbs: '1', totalFloat: null }), task('m', { wbs: '2', totalFloat: 7 })],
      });
      expect(data.kpis.float.value).toBe('7d');
      expect(data.kpis.float.sub).toBe('tightest of 1 off the critical path');
    });

    it('moves the PDF integrity stamp when only the Float KPI changes', () => {
      // Every KPI feeds `scheduleContentSha`. A slot left out of that list makes
      // two materially different sheets hash the same, which is the one thing the
      // stamp exists to prevent.
      const a = build({ tasks: [task('x', { wbs: '1', totalFloat: 2 })] });
      const b = build({ tasks: [task('x', { wbs: '1', totalFloat: 9 })] });
      expect(a.kpis.float.value).not.toBe(b.kpis.float.value);
      expect(a.footer.contentSha).not.toBe(b.footer.contentSha);
    });
  });

  it('computes the window duration from full ISO timestamps, not only date-only strings', () => {
    const data = build({
      tasks: [task('a', { start: '2026-04-01T09:00:00Z', finish: '2026-04-03T17:00:00Z' })],
    });
    expect(data.kpis.window.sub).toBe('3d');
  });

  it('reports an em-dash window and no duration when nothing is dated', () => {
    const data = build({
      tasks: [task('a', { status: 'IN_PROGRESS', start: '', finish: '' })],
    });
    expect(data.kpis.window.value).toBe('—');
    expect(data.kpis.window.sub).toBeNull();
  });

  it('omits the next-milestone hint when every pending milestone is undated', () => {
    const data = build({
      tasks: [
        task('m1', { wbs: '1', isMilestone: true, progress: 0, start: '', finish: '', status: 'IN_PROGRESS' }),
      ],
    });
    expect(data.kpis.milestones.value).toBe('0 / 1 met');
    expect(data.kpis.milestones.sub).toBeNull();
  });
});

describe('buildSchedulePrintData — critical-path chain ordering edges', () => {
  it('sorts undated CP rows first, then by start, then finish, then WBS', () => {
    const data = build({
      tasks: [
        // Same start — the earlier finish must lead.
        task('lateFinish', { wbs: '1', isCritical: true, start: '2026-04-01', finish: '2026-04-05' }),
        task('earlyFinish', { wbs: '2', isCritical: true, start: '2026-04-01', finish: '2026-04-03' }),
        // Same (absent) start AND finish — the WBS code is the final tiebreak.
        // IN_PROGRESS keeps them out of the "unscheduled planned work" carve-out.
        task('u3', { wbs: '3', isCritical: true, status: 'IN_PROGRESS', start: '', finish: '' }),
        task('u4', { wbs: '4', isCritical: true, status: 'IN_PROGRESS', start: '', finish: '' }),
      ],
    });
    expect(data.cpChain.map((t) => t.id)).toEqual(['u3', 'u4', 'earlyFinish', 'lateFinish']);
    expect(data.cpChain.map((t) => t.seq)).toEqual([1, 2, 3, 4]);
    expect(data.cpChain[0].start).toBeNull();
    expect(data.cpChain[0].finish).toBeNull();
  });

  it('keeps the finish tiebreak stable regardless of the incoming WBS order', () => {
    // Same test as above with the two same-start rows swapped in WBS order: the
    // chain order is driven by the finish date, never by the arrival order.
    const data = build({
      tasks: [
        task('earlyFinish', { wbs: '1', isCritical: true, start: '2026-04-01', finish: '2026-04-03' }),
        task('lateFinish', { wbs: '2', isCritical: true, start: '2026-04-01', finish: '2026-04-05' }),
      ],
    });
    expect(data.cpChain.map((t) => t.id)).toEqual(['earlyFinish', 'lateFinish']);
  });
});

describe('scheduleContentSha — undated rows', () => {
  it('fingerprints a row with no dates and shifts once that row is scheduled', () => {
    const undated = build({
      tasks: [task('a', { status: 'IN_PROGRESS', start: '', finish: '' })],
    }).footer.contentSha;
    const dated = build({
      tasks: [task('a', { status: 'IN_PROGRESS', start: '2026-04-01', finish: '2026-04-02' })],
    }).footer.contentSha;
    expect(undated).toMatch(/^[0-9a-f]{8}$/);
    expect(undated).not.toBe(dated);
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

describe('orderLinksForPaint', () => {
  const mk = (id: string, hard: boolean): SchedulePrintLink => ({
    id,
    fromId: 'a',
    toId: 'b',
    type: 'FS',
    hard,
  });

  it('paints soft links first and hard links last (hard on top)', () => {
    const ordered = orderLinksForPaint([mk('h1', true), mk('s1', false), mk('h2', true)]);
    expect(ordered.map((l) => l.id)).toEqual(['s1', 'h1', 'h2']);
  });

  it('preserves incoming order within each group so channel seq stays stable', () => {
    const ordered = orderLinksForPaint([mk('s1', false), mk('s2', false), mk('h1', true)]);
    expect(ordered.map((l) => l.id)).toEqual(['s1', 's2', 'h1']);
  });

  it('does not mutate the input array', () => {
    const input = [mk('h', true), mk('s', false)];
    orderLinksForPaint(input);
    expect(input.map((l) => l.id)).toEqual(['h', 's']);
  });
});

describe('labelIndentPx', () => {
  it('starts at the base padding for level 1', () => {
    expect(labelIndentPx(1)).toBe(LABEL_INDENT_BASE_PX);
  });

  it('adds one step per level up to the cap', () => {
    expect(labelIndentPx(2)).toBe(LABEL_INDENT_BASE_PX + LABEL_INDENT_STEP_PX);
    expect(labelIndentPx(3)).toBe(LABEL_INDENT_BASE_PX + 2 * LABEL_INDENT_STEP_PX);
  });

  it('caps the indent at MAX_INDENT_LEVELS even for a deep WBS', () => {
    const capped = labelIndentPx(MAX_INDENT_LEVELS);
    expect(labelIndentPx(4)).toBe(capped);
    expect(labelIndentPx(9)).toBe(capped);
  });

  it('floors sub-1 levels at the base padding', () => {
    expect(labelIndentPx(0)).toBe(LABEL_INDENT_BASE_PX);
  });
});

describe('buildSchedulePrintData — Unscheduled — Planned Work (#1799)', () => {
  // A sprint-assigned BACKLOG task is CPM-excluded, so it has no start/finish.
  const sprintBacklog = (id: string, sprintId: string, overrides: Partial<Task> = {}) =>
    task(id, { status: 'BACKLOG', sprintId, start: '', finish: '', plannedStart: null, ...overrides });

  const sprint = (id: string, over: Record<string, unknown> = {}) =>
    ({
      id,
      name: `Sprint ${id}`,
      state: 'PLANNED',
      start_date: '2026-07-17',
      finish_date: '2026-07-30',
      ...over,
    }) as unknown as import('@/types').ApiSprint;

  it('groups sprint-assigned backlog by target sprint and carves it out of the chart rows', () => {
    const data = build({
      tasks: [
        task('1', { start: '2026-04-01', finish: '2026-04-05' }), // scheduled → stays charted
        sprintBacklog('2', 's1', { name: 'Contact dedupe' }),
        sprintBacklog('3', 's1', { name: 'Merge rules' }),
      ],
      sprints: [sprint('s1', { name: 'Build Sprint 3' })],
    });

    // The two undated backlog rows are removed from the chart…
    expect(data.rows.map((r) => r.id)).toEqual(['1']);
    // …and surfaced in the dedicated section, grouped under their sprint.
    expect(data.unscheduled.count).toBe(2);
    expect(data.unscheduled.groups).toHaveLength(1);
    const group = data.unscheduled.groups[0];
    expect(group.sprintName).toBe('Build Sprint 3');
    expect(group.windowLabel).toBeTruthy();
    expect(group.tasks.map((t) => t.name)).toEqual(['Contact dedupe', 'Merge rules']);
  });

  it('puts undated no-sprint work in a trailing "No sprint" bucket', () => {
    const data = build({
      tasks: [sprintBacklog('2', 's1'), task('3', { status: 'BACKLOG', sprintId: null, start: '', finish: '', plannedStart: null })],
      sprints: [sprint('s1')],
    });
    const keys = data.unscheduled.groups.map((g) => g.key);
    expect(keys[keys.length - 1]).toBe('__none__');
    expect(data.unscheduled.count).toBe(2);
  });

  it('keeps CPM-dated To Do tasks on the chart (only undated planned work is carved out)', () => {
    const data = build({
      // NOT_STARTED with CPM early dates → still a bar on the chart, not unscheduled.
      tasks: [task('1', { status: 'NOT_STARTED', start: '2026-04-01', finish: '2026-04-03', plannedStart: null })],
    });
    expect(data.rows.map((r) => r.id)).toEqual(['1']);
    expect(data.unscheduled.count).toBe(0);
  });

  it('reports an empty section when there is no planned-but-unscheduled work', () => {
    const data = build({ tasks: [task('1')] });
    expect(data.unscheduled.count).toBe(0);
    expect(data.unscheduled.groups).toHaveLength(0);
  });
});

describe('buildSchedulePrintData — unscheduled group labeling (#1799)', () => {
  const undated = (id: string, overrides: Partial<Task> = {}) =>
    task(id, { status: 'BACKLOG', start: '', finish: '', plannedStart: null, ...overrides });

  const sprint = (id: string, over: Record<string, unknown> = {}) =>
    ({
      id,
      name: `Sprint ${id}`,
      state: 'PLANNED',
      start_date: '2026-07-17',
      finish_date: '2026-07-30',
      ...over,
    }) as unknown as import('@/types').ApiSprint;

  it('carries owner initials onto an unscheduled row', () => {
    const data = build({
      tasks: [
        undated('u1', { assignees: [{ resourceId: 'r1', name: 'Ada Lovelace', units: 1 }] }),
        undated('u2'),
      ],
    });
    const bucket = data.unscheduled.groups[0].tasks;
    expect(bucket.map((t) => t.ownerInitials)).toEqual(['AL', null]);
  });

  it('labels a group whose sprint is not in the sprint list generically', () => {
    // Sprints are optional on the export args, so a sprint-assigned backlog row
    // can reference an id the caller never supplied — it must still group and
    // render, just without a window or state.
    const data = build({ tasks: [undated('u1', { sprintId: 'ghost' })], sprints: [] });
    const group = data.unscheduled.groups[0];
    expect(group.key).toBe('ghost');
    expect(group.sprintName).toBe('Sprint');
    expect(group.windowLabel).toBeNull();
    expect(group.stateLabel).toBeNull();
  });

  it('omits the window label when the sprint has no dates and title-cases its state', () => {
    const data = build({
      tasks: [undated('u1', { sprintId: 's1' })],
      sprints: [
        sprint('s1', { name: 'Hardening', start_date: '', finish_date: '', state: 'ACTIVE' }),
      ],
    });
    const group = data.unscheduled.groups[0];
    expect(group.sprintName).toBe('Hardening');
    expect(group.windowLabel).toBeNull();
    expect(group.stateLabel).toBe('Active');
  });

  it('orders sprint groups by sprint start date', () => {
    const data = build({
      tasks: [
        undated('a', { sprintId: 'late' }),
        undated('b', { sprintId: 'early' }),
        undated('c', { sprintId: 'ghost1' }),
        undated('d', { sprintId: 'ghost2' }),
      ],
      sprints: [
        sprint('late', { start_date: '2026-09-01', finish_date: '2026-09-14' }),
        sprint('early', { start_date: '2026-07-01', finish_date: '2026-07-14' }),
      ],
    });
    const keys = data.unscheduled.groups.map((g) => g.key);
    expect(keys).toHaveLength(4);
    expect(keys.indexOf('early')).toBeLessThan(keys.indexOf('late'));
    expect(data.unscheduled.count).toBe(4);
  });

  it('excludes a To Do row that already carries a PM-committed planned start', () => {
    const data = build({
      tasks: [undated('u1', { plannedStart: '2026-05-01', status: 'NOT_STARTED' })],
    });
    expect(data.unscheduled.count).toBe(0);
    // It stays a chart row (blank bar) rather than moving to the section.
    expect(data.rows.map((r) => r.id)).toEqual(['u1']);
  });

  it('excludes an undated summary row and a sprint-assigned To Do row', () => {
    const data = build({
      tasks: [
        undated('summary', { wbs: '1', isSummary: true }),
        // NOT_STARTED + a sprint is an active-sprint commitment, not backlog intake.
        undated('sprinted', { wbs: '2', status: 'NOT_STARTED', sprintId: 's1' }),
        // …and a status outside the tray predicate never qualifies.
        undated('doing', { wbs: '3', status: 'IN_PROGRESS' }),
      ],
    });
    expect(data.unscheduled.count).toBe(0);
    expect(data.rows.map((r) => r.id)).toEqual(['summary', 'sprinted', 'doing']);
  });
});
