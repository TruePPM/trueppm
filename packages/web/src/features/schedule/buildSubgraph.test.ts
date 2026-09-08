import { describe, it, expect } from 'vitest';
import { buildSubgraph } from './buildSubgraph';
import type { Task, TaskLink } from '@/types';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    wbs: id,
    name: id,
    start: '2025-01-06',
    finish: '2025-01-10',
    duration: 5,
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
  };
}

function link(id: string, sourceId: string, targetId: string, type: TaskLink['type'] = 'FS'): TaskLink {
  return { id, sourceId, targetId, type, lag: 0, isCritical: false };
}

describe('buildSubgraph', () => {
  it('returns only the start task when it has no successors', () => {
    const tasks = [task('A'), task('B')];
    const { tasks: subTasks, edges } = buildSubgraph('A', tasks, []);
    expect(subTasks).toHaveLength(1);
    expect(subTasks[0].id).toBe('A');
    expect(edges).toHaveLength(0);
  });

  it('includes direct successors', () => {
    const tasks = [task('A'), task('B'), task('C')];
    const links = [link('l1', 'A', 'B')];
    const { tasks: subTasks } = buildSubgraph('A', tasks, links);
    const ids = subTasks.map((t) => t.id).sort();
    expect(ids).toEqual(['A', 'B']);
  });

  it('includes transitive successors', () => {
    const tasks = [task('A'), task('B'), task('C'), task('D')];
    const links = [link('l1', 'A', 'B'), link('l2', 'B', 'C'), link('l3', 'C', 'D')];
    const { tasks: subTasks } = buildSubgraph('A', tasks, links);
    expect(subTasks).toHaveLength(4);
  });

  it('excludes tasks upstream of start', () => {
    const tasks = [task('Upstream'), task('A'), task('B')];
    const links = [link('l1', 'Upstream', 'A'), link('l2', 'A', 'B')];
    const { tasks: subTasks } = buildSubgraph('A', tasks, links);
    const ids = subTasks.map((t) => t.id);
    expect(ids).not.toContain('Upstream');
    expect(ids).toContain('A');
    expect(ids).toContain('B');
  });

  it('includes only edges internal to the subgraph', () => {
    const tasks = [task('Upstream'), task('A'), task('B')];
    const links = [link('l1', 'Upstream', 'A'), link('l2', 'A', 'B')];
    const { edges } = buildSubgraph('A', tasks, links);
    // l1 has Upstream (not in subgraph) → excluded; l2 is internal → included
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe('A');
    expect(edges[0].targetId).toBe('B');
  });

  it('maps CpmTask fields correctly', () => {
    const t = task('A', {
      start: '2025-03-01',
      finish: '2025-03-05',
      // baselineFinish is a distinct (baseline-plan) field — it must NOT be
      // read as lateFinish (issue #1493: this was the wrong-proxy bug).
      baselineFinish: '2025-03-04',
      lateFinish: '2025-03-10',
      isMilestone: true,
      name: 'Launch',
    });
    const { tasks: subTasks } = buildSubgraph('A', [t], []);
    const ct = subTasks[0];
    expect(ct.earlyStart).toBe('2025-03-01');
    expect(ct.earlyFinish).toBe('2025-03-05');
    expect(ct.lateFinish).toBe('2025-03-10'); // real CPM late_finish, not baselineFinish
    expect(ct.isMilestone).toBe(true);
    expect(ct.name).toBe('Launch');
  });

  it('does not fall back to baselineFinish when lateFinish is absent (issue #1493)', () => {
    // Before the fix this would have returned '2025-03-04' (baselineFinish) —
    // a baseline-plan snapshot, not a CPM late_finish, and a materially
    // different date that made the CP-flip badge mis-fire.
    const t = task('A', {
      finish: '2025-03-05',
      baselineFinish: '2025-03-04',
      lateFinish: undefined,
    });
    const { tasks: subTasks } = buildSubgraph('A', [t], []);
    expect(subTasks[0].lateFinish).toBe('2025-03-05'); // falls back to finish, not baselineFinish
  });

  it('falls back to finish when lateFinish is absent (pre-CPM-run task)', () => {
    const t = task('A', { finish: '2025-03-05', lateFinish: undefined });
    const { tasks: subTasks } = buildSubgraph('A', [t], []);
    expect(subTasks[0].lateFinish).toBe('2025-03-05');
  });

  it('threads lag through onto the CpmEdge (issue #1493)', () => {
    const tasks = [task('A'), task('B')];
    const links = [{ ...link('l1', 'A', 'B'), lag: 3 }];
    const { edges } = buildSubgraph('A', tasks, links);
    expect(edges).toHaveLength(1);
    expect(edges[0].lag).toBe(3);
  });

  it('handles cycles — does not loop infinitely when two tasks point to each other', () => {
    // A → B → A (cycle) — BFS visited check prevents infinite loop
    const tasks = [task('A'), task('B')];
    const links = [link('l1', 'A', 'B'), link('l2', 'B', 'A')];
    const { tasks: subTasks } = buildSubgraph('A', tasks, links);
    // Both A and B are reachable; no infinite loop
    expect(subTasks.map((t) => t.id).sort()).toEqual(['A', 'B']);
  });

  it('handles startTaskId not found in tasks — returns empty results', () => {
    const tasks = [task('A'), task('B')];
    // 'MISSING' is not in tasks — outgoing.get will return undefined, BFS visits it
    // but taskIndex.get returns undefined so it is skipped in cpmTasks
    const { tasks: subTasks, edges } = buildSubgraph('MISSING', tasks, []);
    // 'MISSING' is in visited but not in taskIndex — skipped; no crash
    expect(subTasks).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('does not include edges where only one end is in the subgraph', () => {
    // A has no links, but a link from X→A exists. Starting from A only includes A.
    const tasks = [task('A'), task('X')];
    const links = [link('l1', 'X', 'A')];
    const { edges } = buildSubgraph('A', tasks, links);
    // X is not reachable from A, so this edge is excluded
    expect(edges).toHaveLength(0);
  });

  it('includes self-loop edge when task links to itself', () => {
    const tasks = [task('A')];
    const links = [link('l1', 'A', 'A')];
    const { edges } = buildSubgraph('A', tasks, links);
    // A is in visited, A is in visited → internal edge is included
    expect(edges).toHaveLength(1);
  });

  // ADR-0132 progress facts (#2813). These already existed on the web `Task`;
  // the preview subgraph simply never carried them across the worker boundary,
  // so the engine could not apply the pin / remaining-duration / actual-start
  // floors and previewed dates the server contradicted on commit.
  describe('progress fields', () => {
    it('carries the ADR-0132 progress facts through to the CPM task', () => {
      const tasks = [
        task('A', {
          duration: 10,
          progress: 80,
          remainingDuration: 2,
          actualStart: '2026-01-05',
        }),
      ];
      const { tasks: subTasks } = buildSubgraph('A', tasks, []);

      expect(subTasks[0]).toMatchObject({
        // The FULL duration — the engine derives the remaining portion itself.
        durationDays: 10,
        remainingDuration: 2,
        actualStart: '2026-01-05',
        isComplete: false,
      });
    });

    it('carries both actuals for a completed task so the engine can pin it', () => {
      const tasks = [
        task('A', {
          isComplete: true,
          status: 'COMPLETE',
          progress: 100,
          actualStart: '2026-01-05',
          actualFinish: '2026-01-09',
        }),
      ];
      const { tasks: subTasks } = buildSubgraph('A', tasks, []);

      expect(subTasks[0].isComplete).toBe(true);
      expect(subTasks[0].actualStart).toBe('2026-01-05');
      expect(subTasks[0].actualFinish).toBe('2026-01-09');
    });

    it('normalises absent progress facts to null rather than dropping the keys', () => {
      // A payload that predates the fields (an older WebSocket delta, an
      // optimistic local create) must not read as "0 days of work left".
      const { tasks: subTasks } = buildSubgraph('A', [task('A')], []);

      expect(subTasks[0].remainingDuration).toBeNull();
      expect(subTasks[0].actualStart).toBeNull();
      expect(subTasks[0].actualFinish).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Summary dependency expansion (issue #3535)
//
// A summary's children are WBS containment, not link edges, so a BFS over
// literal TaskLink rows could not reach a task gated on a summary from a drag
// that started inside the phase — the successor was ABSENT from the preview.
// These mirror the server's `expand_summary_dependencies`, including the two
// places this deliberately deviates from it.
// ---------------------------------------------------------------------------

describe('buildSubgraph — summary dependency expansion', () => {
  /** S is a summary over C1/C2; A → C1 is a leaf link and S → B gates B. */
  function phaseFixture() {
    return {
      tasks: [
        task('A'),
        task('S', { isSummary: true }),
        task('C1', { parentId: 'S' }),
        task('C2', { parentId: 'S' }),
        task('B'),
      ],
      links: [link('l1', 'A', 'C1'), link('l2', 'S', 'B')],
    };
  }

  it('reaches a summary-gated successor from a drag inside the phase', () => {
    const { tasks, links } = phaseFixture();
    const { tasks: subTasks } = buildSubgraph('A', tasks, links);
    // Pre-#3535: ['A', 'C1'] — B was never reached.
    expect(subTasks.map((t) => t.id).sort()).toEqual(['A', 'B', 'C1']);
  });

  it('rewrites the summary edge onto the leaf that is actually in the subgraph', () => {
    const { tasks, links } = phaseFixture();
    const { edges } = buildSubgraph('A', tasks, links);
    expect(edges).toContainEqual({ sourceId: 'C1', targetId: 'B', type: 'FS', lag: 0 });
    // The S → B edge itself is gone: nothing in the preview names a summary.
    expect(edges.some((e) => e.sourceId === 'S' || e.targetId === 'S')).toBe(false);
  });

  it('preserves the link type and lag across the fan-out', () => {
    const tasks = [
      task('A'),
      task('S', { isSummary: true }),
      task('C1', { parentId: 'S' }),
      task('B'),
    ];
    const links = [
      link('l1', 'A', 'C1'),
      { ...link('l2', 'S', 'B', 'FF'), lag: 3 },
    ];
    const { edges } = buildSubgraph('A', tasks, links);
    expect(edges).toContainEqual({ sourceId: 'C1', targetId: 'B', type: 'FF', lag: 3 });
  });

  it('expands a link INTO a summary onto each of its leaves', () => {
    const tasks = [
      task('A'),
      task('S', { isSummary: true }),
      task('C1', { parentId: 'S' }),
      task('C2', { parentId: 'S' }),
    ];
    const { tasks: subTasks } = buildSubgraph('A', tasks, [link('l1', 'A', 'S')]);
    expect(subTasks.map((t) => t.id).sort()).toEqual(['A', 'C1', 'C2']);
  });

  it('walks nested summaries down to real leaves', () => {
    const tasks = [
      task('A'),
      task('S', { isSummary: true }),
      task('Mid', { parentId: 'S', isSummary: true }),
      task('Leaf', { parentId: 'Mid' }),
    ];
    const { tasks: subTasks } = buildSubgraph('A', tasks, [link('l1', 'A', 'S')]);
    expect(subTasks.map((t) => t.id).sort()).toEqual(['A', 'Leaf']);
  });

  it('drops a self-edge produced by expanding a link inside one phase', () => {
    // S → S' where both resolve onto the same leaf would deadlock the
    // topological sort; the server skips these too.
    const tasks = [
      task('S', { isSummary: true }),
      task('C1', { parentId: 'S' }),
    ];
    const { edges } = buildSubgraph('C1', tasks, [link('l1', 'S', 'S')]);
    expect(edges.some((e) => e.sourceId === e.targetId)).toBe(false);
  });

  it('deduplicates two summary links that land on the same leaf pair', () => {
    const tasks = [
      task('A'),
      task('S', { isSummary: true }),
      task('C1', { parentId: 'S' }),
      task('B'),
    ];
    const links = [link('l1', 'A', 'C1'), link('l2', 'S', 'B'), link('l3', 'S', 'B')];
    const { edges } = buildSubgraph('A', tasks, links);
    expect(edges.filter((e) => e.sourceId === 'C1' && e.targetId === 'B')).toHaveLength(1);
  });

  it('does not conflate two leaf pairs whose ids concatenate to the same string (issue #3601)', () => {
    // The dedup key that guards the test above joins source/target with a
    // delimiter. A literal NUL byte previously served that role and made git
    // classify the whole file as binary (#3601); the fix keeps the same
    // runtime separator, expressed without an embedded raw byte. Either way,
    // the delimiter's job is to keep 'A' + '1B' distinct from 'A1' + 'B' — a
    // plain concatenation with no separator would collide both onto 'A1B' and
    // silently drop the second pair as a false duplicate.
    const tasks = [
      task('A'),
      task('S1', { isSummary: true }),
      task('1B', { parentId: 'S1' }),
      task('S2', { isSummary: true }),
      task('A1', { parentId: 'S2' }),
      task('B'),
    ];
    const links = [link('l1', 'A', 'S1'), link('l2', 'S2', 'B'), link('l3', '1B', 'A1')];
    const { edges } = buildSubgraph('A', tasks, links);
    expect(edges).toContainEqual({ sourceId: 'A', targetId: '1B', type: 'FS', lag: 0 });
    expect(edges).toContainEqual({ sourceId: 'A1', targetId: 'B', type: 'FS', lag: 0 });
  });

  it('drops an SS link from a summary rather than fanning it out (ADR-0370)', () => {
    // `_reject_summary_start_links` refuses this link outright — fanning a
    // start-side constraint across every leaf silently over-constrains the
    // successor (#1854). Showing nothing beats showing a slip the server will
    // never produce.
    const tasks = [
      task('A'),
      task('S', { isSummary: true }),
      task('C1', { parentId: 'S' }),
      task('B'),
    ];
    const links = [link('l1', 'A', 'C1'), link('l2', 'S', 'B', 'SS')];
    const { edges, tasks: subTasks } = buildSubgraph('A', tasks, links);
    expect(edges.some((e) => e.targetId === 'B')).toBe(false);
    expect(subTasks.map((t) => t.id).sort()).toEqual(['A', 'C1']);
  });

  it('keeps a summary drag root wired to its own successors', () => {
    // The server drops summary NODES because it recomputes their dates by
    // rollup; the preview has no rollup pass, so dropping the node being
    // dragged would leave an empty subgraph. Pre-#3535 behavior is preserved
    // for this one gesture rather than regressed to nothing.
    const tasks = [
      task('S', { isSummary: true }),
      task('C1', { parentId: 'S' }),
      task('B'),
    ];
    const { tasks: subTasks } = buildSubgraph('S', tasks, [link('l1', 'S', 'B')]);
    expect(subTasks.map((t) => t.id).sort()).toEqual(['B', 'S']);
  });

  it('leaves a summary-free schedule byte-identical', () => {
    const tasks = [task('A'), task('B'), task('C')];
    const links = [link('l1', 'A', 'B'), link('l2', 'B', 'C')];
    const { edges } = buildSubgraph('A', tasks, links);
    expect(edges).toEqual([
      { sourceId: 'A', targetId: 'B', type: 'FS', lag: 0 },
      { sourceId: 'B', targetId: 'C', type: 'FS', lag: 0 },
    ]);
  });

  it('carries planned_start across to the worker', () => {
    // The SNET floor the engine needs now that it can pull tasks earlier.
    const tasks = [task('A', { plannedStart: '2025-02-03' })];
    const { tasks: subTasks } = buildSubgraph('A', tasks, []);
    expect(subTasks[0].plannedStart).toBe('2025-02-03');
  });
});
