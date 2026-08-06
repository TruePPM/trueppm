import { describe, it, expect } from 'vitest';
import { computeSprintBands, sprintBandByTaskId, type SprintWindowSource } from './sprintBands';
import type { Task } from '@/types';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
    start: '2026-04-06',
    finish: '2026-04-10',
    duration: 5,
    progress: 0,
    isSummary: false,
    isMilestone: false,
    isCritical: false,
    parentId: null,
    wbs: '1',
    ...over,
  } as unknown as Task;
}

function sprint(id: string, over: Partial<SprintWindowSource> = {}): SprintWindowSource {
  return {
    id,
    name: `Sprint ${id}`,
    start_date: '2026-04-06',
    finish_date: '2026-04-17',
    state: 'ACTIVE',
    ...over,
  };
}

describe('computeSprintBands — row attribution (#2738)', () => {
  it('returns no bands when there are no sprints or no tasks', () => {
    expect(computeSprintBands([task('a', { sprintId: 's1' })], [])).toEqual([]);
    expect(computeSprintBands([], [sprint('s1')])).toEqual([]);
  });

  it('bands a contiguous run of rows committed to the same sprint', () => {
    const tasks = [
      task('a', { sprintId: 's1' }),
      task('b', { sprintId: 's1' }),
      task('c', { sprintId: 's1' }),
    ];
    const bands = computeSprintBands(tasks, [sprint('s1')]);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({
      sprintId: 's1',
      name: 'Sprint s1',
      startDate: '2026-04-06',
      finishDate: '2026-04-17',
      firstRow: 0,
      lastRow: 2,
    });
  });

  it('breaks into separate bands rather than spanning rows in no sprint', () => {
    // The correctness argument for contiguous runs: a band is a claim about
    // EVERY row it covers, so min(row)…max(row) would falsely claim row 1.
    const tasks = [
      task('a', { sprintId: 's1' }),
      task('gap'),
      task('c', { sprintId: 's1' }),
    ];
    const bands = computeSprintBands(tasks, [sprint('s1')]);
    expect(bands.map((b) => [b.firstRow, b.lastRow])).toEqual([
      [0, 0],
      [2, 2],
    ]);
  });

  it('starts a new band at a sprint boundary between adjacent rows', () => {
    const tasks = [task('a', { sprintId: 's1' }), task('b', { sprintId: 's2' })];
    const bands = computeSprintBands(tasks, [sprint('s1'), sprint('s2')]);
    expect(bands.map((b) => b.sprintId)).toEqual(['s1', 's2']);
    expect(bands.map((b) => [b.firstRow, b.lastRow])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('covers a phase row whose whole subtree sits in one sprint', () => {
    const tasks = [
      task('phase', { isSummary: true }),
      task('a', { parentId: 'phase', sprintId: 's1' }),
      task('b', { parentId: 'phase', sprintId: 's1' }),
    ];
    const bands = computeSprintBands(tasks, [sprint('s1')]);
    expect(bands).toHaveLength(1);
    // The phase reads from its DESCENDANTS, so the band starts on the phase row.
    expect(bands[0].firstRow).toBe(0);
    expect(bands[0].lastRow).toBe(2);
  });

  it('drops the phase row when its branches disagree, banding the children only', () => {
    const tasks = [
      task('phase', { isSummary: true }),
      task('a', { parentId: 'phase', sprintId: 's1' }),
      task('b', { parentId: 'phase', sprintId: 's2' }),
    ];
    const bands = computeSprintBands(tasks, [sprint('s1'), sprint('s2')]);
    expect(bands.map((b) => [b.sprintId, b.firstRow, b.lastRow])).toEqual([
      ['s1', 1, 1],
      ['s2', 2, 2],
    ]);
  });

  it('does not let a gate inside a sprint-driven phase split the band', () => {
    // `is_milestone ⟺ delivery_mode = milestone ⟺ duration = 0` is one coupled
    // fact — a gate contributes no sprint, so the phase still reads as single-
    // sprint and the band stays whole.
    const tasks = [
      task('phase', { isSummary: true }),
      task('a', { parentId: 'phase', sprintId: 's1' }),
      task('gate', { parentId: 'phase', isMilestone: true, duration: 0 }),
      task('b', { parentId: 'phase', sprintId: 's1' }),
    ];
    const bands = computeSprintBands(tasks, [sprint('s1')]);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ firstRow: 0, lastRow: 3 });
  });

  it('ignores a milestone row own sprint id when rolling a phase up', () => {
    const tasks = [
      task('phase', { isSummary: true }),
      task('gate', { parentId: 'phase', isMilestone: true, sprintId: 's2' }),
      task('a', { parentId: 'phase', sprintId: 's1' }),
    ];
    const bands = computeSprintBands(tasks, [sprint('s1'), sprint('s2')]);
    expect(bands).toHaveLength(1);
    expect(bands[0].sprintId).toBe('s1');
  });

  it('falls back to a phase own sprint when it has no contributing descendants', () => {
    const tasks = [
      task('phase', { isSummary: true, sprintId: 's1' }),
      task('gate', { parentId: 'phase', isMilestone: true }),
    ];
    const bands = computeSprintBands(tasks, [sprint('s1')]);
    // The gate contributes nothing to the rollup but still INHERITS the band —
    // a hole at the gate row would read as a rendering fault, not as a fact.
    expect(bands.map((b) => [b.firstRow, b.lastRow])).toEqual([[0, 1]]);
  });

  it('covers an uncommitted task inside a sprint-driven phase', () => {
    // The band spans the rows of the SUBTREE, not only the committed rows —
    // otherwise a task nobody has pulled in yet punches a hole through it.
    const tasks = [
      task('phase', { isSummary: true }),
      task('a', { parentId: 'phase', sprintId: 's1' }),
      task('loose', { parentId: 'phase' }),
      task('b', { parentId: 'phase', sprintId: 's1' }),
    ];
    const bands = computeSprintBands(tasks, [sprint('s1')]);
    expect(bands.map((b) => [b.firstRow, b.lastRow])).toEqual([[0, 3]]);
  });

  it('draws nothing for a CANCELLED sprint, and breaks the run at it', () => {
    const tasks = [
      task('a', { sprintId: 's1' }),
      task('b', { sprintId: 'dead' }),
      task('c', { sprintId: 's1' }),
    ];
    const bands = computeSprintBands(tasks, [
      sprint('s1'),
      sprint('dead', { state: 'CANCELLED' }),
    ]);
    expect(bands.map((b) => [b.sprintId, b.firstRow, b.lastRow])).toEqual([
      ['s1', 0, 0],
      ['s1', 2, 2],
    ]);
  });

  it('bands PLANNED and COMPLETED sprints — past and future cadence both count', () => {
    const tasks = [task('a', { sprintId: 'done' }), task('b', { sprintId: 'next' })];
    const bands = computeSprintBands(tasks, [
      sprint('done', { state: 'COMPLETED' }),
      sprint('next', { state: 'PLANNED' }),
    ]);
    expect(bands.map((b) => b.sprintId)).toEqual(['done', 'next']);
  });

  it('skips a sprint missing either window date', () => {
    const tasks = [task('a', { sprintId: 's1' })];
    expect(computeSprintBands(tasks, [sprint('s1', { finish_date: '' })])).toEqual([]);
  });

  it('treats an unknown sprint id as no band rather than merging across it', () => {
    // A sprint past useSprints' first page is not in the window map; the row is
    // genuinely uncovered, so the run must break there.
    const tasks = [
      task('a', { sprintId: 's1' }),
      task('b', { sprintId: 'unpaged' }),
      task('c', { sprintId: 's1' }),
    ];
    const bands = computeSprintBands(tasks, [sprint('s1')]);
    expect(bands).toHaveLength(2);
  });

  it('resolves an orphan row whose parent is outside the loaded set', () => {
    const tasks = [task('a', { parentId: 'not-loaded', sprintId: 's1' })];
    const bands = computeSprintBands(tasks, [sprint('s1')]);
    expect(bands.map((b) => [b.firstRow, b.lastRow])).toEqual([[0, 0]]);
  });

  it('does not blow the stack on a deep chain', () => {
    const tasks: Task[] = [];
    for (let i = 0; i < 5000; i++) {
      tasks.push(task(`t${i}`, { parentId: i === 0 ? null : `t${i - 1}`, sprintId: 's1' }));
    }
    const bands = computeSprintBands(tasks, [sprint('s1')]);
    expect(bands).toHaveLength(1);
    expect(bands[0].lastRow).toBe(4999);
  });
});

describe('sprintBandByTaskId (#2738)', () => {
  it('maps every covered row to its whole band, dates included', () => {
    const tasks = [task('a', { sprintId: 's1' }), task('b'), task('c', { sprintId: 's1' })];
    const bands = computeSprintBands(tasks, [sprint('s1', { name: 'Sprint 4' })]);
    const byTask = sprintBandByTaskId(tasks, bands);
    expect(byTask.get('a')?.name).toBe('Sprint 4');
    // The dates come with it — the aria label reads the bar against the window,
    // not just its membership.
    expect(byTask.get('a')?.finishDate).toBe('2026-04-17');
    expect(byTask.get('c')?.name).toBe('Sprint 4');
    // An uncovered row must map to nothing — the aria suffix has to stay silent
    // where the band is silent, or it claims a window the chart never drew.
    expect(byTask.has('b')).toBe(false);
  });

  it('is empty when there are no bands', () => {
    expect(sprintBandByTaskId([task('a')], []).size).toBe(0);
  });
});
