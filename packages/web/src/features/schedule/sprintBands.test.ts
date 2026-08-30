import { describe, it, expect } from 'vitest';
import {
  computeCadenceSegments,
  computeSprintBands,
  emptySprintWindows,
  sprintBandByTaskId,
  type SprintWindowSource,
} from './sprintBands';
import type { SprintState, Task } from '@/types';

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

describe('computeSprintBands — a phase reads from its descendants (#2738)', () => {
  /**
   * The rollup rule: a row contributes its OWN sprint only when no descendant
   * contributed one. Without it a phase carrying a stale sprint of its own would
   * disagree with its children and resolve the whole subtree to "mixed", which
   * silently deletes the band.
   *
   * This was uncovered here until #3204 — mutating the rule left all 34 existing
   * cases green, because none of them gives a parent a sprint that differs from
   * its children's.
   */
  it('ignores a phase\'s own sprint when its children all agree on another', () => {
    const tasks = [
      task('phase', { sprintId: 's2', isSummary: true }),
      task('kid-1', { sprintId: 's1', parentId: 'phase' }),
      task('kid-2', { sprintId: 's1', parentId: 'phase' }),
    ];
    const bands = computeSprintBands(tasks, [sprint('s1'), sprint('s2')]);
    // One band, for s1 — the children's sprint — covering all three rows.
    expect(bands).toHaveLength(1);
    expect(bands[0].sprintId).toBe('s1');
    expect(sprintBandByTaskId(tasks, bands).get('phase')?.sprintId).toBe('s1');
  });

  it('resolves a phase to no band when its children disagree', () => {
    const tasks = [
      task('phase', { isSummary: true }),
      task('kid-1', { sprintId: 's1', parentId: 'phase' }),
      task('kid-2', { sprintId: 's2', parentId: 'phase' }),
    ];
    const bands = computeSprintBands(tasks, [sprint('s1'), sprint('s2')]);
    expect(sprintBandByTaskId(tasks, bands).get('phase')).toBeUndefined();
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

describe('computeCadenceSegments — naming every window on the axis (#3012)', () => {
  const win = (
    id: string,
    start: string,
    finish: string,
    state: SprintState = 'PLANNED',
    name = id.toUpperCase(),
  ): SprintWindowSource => ({ id, name, start_date: start, finish_date: finish, state });

  it('emits a cell for a sprint with NO committed work', () => {
    // The reason the rail exists. `computeSprintBands` returns [] for this input
    // because no row resolves to the sprint — so an empty sprint, which is a
    // real planning fact, is invisible on the chart without this.
    const sprints = [win('s1', '2026-04-06', '2026-04-17')];
    expect(computeSprintBands([], sprints)).toEqual([]);
    expect(computeCadenceSegments(sprints)).toEqual([
      {
        startDate: '2026-04-06',
        finishDate: '2026-04-17',
        label: 'S1',
        sprintIds: ['s1'],
        active: false,
      },
    ]);
  });

  it('names one sprint ONCE however its work is scattered across the WBS', () => {
    // Bands are maximal contiguous ROW runs, so a scattered sprint produces
    // several bands and therefore several copies of one name. The rail is
    // addressed by date, so it cannot.
    const segments = computeCadenceSegments([win('s1', '2026-04-06', '2026-04-17')]);
    expect(segments.map((s) => s.label)).toEqual(['S1']);
  });

  it('skips a CANCELLED sprint, via the same predicate the bands use', () => {
    // A cancelled sprint named a window that never governed any work. The rail
    // and the bands must never disagree about which sprints are drawable, which
    // is why `drawsABand` is shared rather than reimplemented here.
    expect(computeCadenceSegments([win('s1', '2026-04-06', '2026-04-17', 'CANCELLED')])).toEqual(
      [],
    );
  });

  it('skips a sprint with no window at all', () => {
    expect(
      computeCadenceSegments([{ id: 's1', name: 'S1', start_date: '', finish_date: '', state: 'PLANNED' }]),
    ).toEqual([]);
  });

  it('drops an inverted window rather than normalizing it', () => {
    // Normalizing would invent a window nobody planned.
    expect(computeCadenceSegments([win('s1', '2026-04-17', '2026-04-06')])).toEqual([]);
  });

  it('splits overlapping windows into segments instead of stacking them', () => {
    // The rail is ONE row and its height feeds CHART_HEADER_HEIGHT — a second
    // row would move every task's origin mid-scroll. So overlap is expressed
    // along the axis, not up it.
    const segments = computeCadenceSegments([
      win('s1', '2026-04-01', '2026-04-10'),
      win('s2', '2026-04-06', '2026-04-15'),
    ]);
    expect(segments).toEqual([
      {
        startDate: '2026-04-01',
        finishDate: '2026-04-05',
        label: 'S1',
        sprintIds: ['s1'],
        active: false,
      },
      {
        startDate: '2026-04-06',
        finishDate: '2026-04-10',
        label: '2 sprints',
        sprintIds: ['s1', 's2'],
        active: false,
      },
      {
        startDate: '2026-04-11',
        finishDate: '2026-04-15',
        label: 'S2',
        sprintIds: ['s2'],
        active: false,
      },
    ]);
  });

  it('never names ONE of two overlapping sprints', () => {
    // Showing one name over a stretch both sprints cover asserts that the other
    // does not cover it — a lie about the plan rather than a truncation of it.
    const segments = computeCadenceSegments([
      win('s1', '2026-04-01', '2026-04-10'),
      win('s2', '2026-04-01', '2026-04-10'),
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0].label).toBe('2 sprints');
    expect(segments[0].sprintIds).toEqual(['s1', 's2']);
  });

  it('marks a cell ACTIVE when ANY covering sprint is active', () => {
    // `any`, not `all`: the emphasis marks where the team is now, and an active
    // sprint overlapped by a planned one is still where the team is now.
    const segments = computeCadenceSegments([
      win('s1', '2026-04-01', '2026-04-10', 'ACTIVE'),
      win('s2', '2026-04-01', '2026-04-10', 'PLANNED'),
    ]);
    expect(segments[0].active).toBe(true);
  });

  it('leaves a gap between two sprints uncovered', () => {
    // The space between two sprints is not a nameless sprint.
    const segments = computeCadenceSegments([
      win('s1', '2026-04-01', '2026-04-05'),
      win('s2', '2026-04-13', '2026-04-17'),
    ]);
    expect(segments.map((s) => [s.startDate, s.finishDate])).toEqual([
      ['2026-04-01', '2026-04-05'],
      ['2026-04-13', '2026-04-17'],
    ]);
  });

  it('does not leave a hairline through a window whose boundary changes nothing', () => {
    // Two sprints sharing a start date cut the partition at one boundary that
    // turns out not to change the covering set on either side of the next one.
    const segments = computeCadenceSegments([
      win('s1', '2026-04-01', '2026-04-10'),
      win('s2', '2026-04-01', '2026-04-10'),
    ]);
    expect(segments).toHaveLength(1);
  });

  it('closes the finish day, like every other finish date in the scheduler', () => {
    const segments = computeCadenceSegments([win('s1', '2026-04-06', '2026-04-06')]);
    expect(segments).toEqual([
      {
        startDate: '2026-04-06',
        finishDate: '2026-04-06',
        label: 'S1',
        sprintIds: ['s1'],
        active: false,
      },
    ]);
  });
});

// #3060: the one fact the rail adds over the bands, and the one with no row to
// announce it.
describe('emptySprintWindows — the rail cells no band covers (#3060)', () => {
  it('names a sprint with no committed work', () => {
    const sprints = [sprint('s1')];
    const bands = computeSprintBands([], sprints);
    expect(bands).toEqual([]);
    expect(emptySprintWindows(sprints, bands)).toEqual([
      { id: 's1', name: 'Sprint s1', startDate: '2026-04-06', finishDate: '2026-04-17' },
    ]);
  });

  it('says nothing about a sprint that DOES drive rows — those are on the bars already', () => {
    const sprints = [sprint('s1')];
    const bands = computeSprintBands([task('a', { sprintId: 's1' })], sprints);
    expect(bands).toHaveLength(1);
    expect(emptySprintWindows(sprints, bands)).toEqual([]);
  });

  it('reports empty ON THIS SCREEN — a sprint whose only rows are filtered out is empty', () => {
    // `computeSprintBands` runs over `visibleTasks`, so this matches the rail the
    // sighted user is looking at rather than contradicting it.
    const sprints = [sprint('s1')];
    expect(emptySprintWindows(sprints, computeSprintBands([], sprints))).toHaveLength(1);
  });

  it('excludes sprints the rail itself does not draw — cancelled, dateless, inverted', () => {
    const sprints = [
      sprint('cancelled', { state: 'CANCELLED' as SprintState }),
      sprint('nodates', { start_date: '', finish_date: '' }),
      sprint('inverted', { start_date: '2026-04-17', finish_date: '2026-04-06' }),
    ];
    // None of these draws a rail cell, so none of them is "missing" from it.
    expect(computeCadenceSegments(sprints)).toEqual([]);
    expect(emptySprintWindows(sprints, [])).toEqual([]);
  });

  it('orders by window start so the sentence reads in cadence order', () => {
    const sprints = [
      sprint('c', { start_date: '2026-05-04', finish_date: '2026-05-15' }),
      sprint('a', { start_date: '2026-04-06', finish_date: '2026-04-17' }),
      sprint('b', { start_date: '2026-04-20', finish_date: '2026-05-01' }),
    ];
    expect(emptySprintWindows(sprints, []).map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });
});
