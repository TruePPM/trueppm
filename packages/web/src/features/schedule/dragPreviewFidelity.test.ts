/**
 * Drag-preview fidelity against the server CPM (issue #3535).
 *
 * The two repros in #3535, run through the REAL `buildSubgraph` +
 * `runCpmForwardPass` pair a drag actually uses — not the engine alone. Both
 * mechanisms lived in the seam between them, which is why the per-module suites
 * (`buildSubgraph.test.ts`, `cpmEngine.test.ts`) were both green while the
 * preview under-reported: each module was correct about the graph it was given.
 *
 * "Under-reports" is the whole point of the class: the preview never showed MORE
 * movement than the server would produce, only less, so the user committed
 * believing nothing else moved. Every expectation below is therefore stated as
 * the SERVER's answer, with the pre-fix client answer named in a comment so a
 * regression reads as "back to the #3535 numbers" rather than as an arbitrary
 * date change.
 */

import { describe, it, expect } from 'vitest';
import { buildSubgraph } from './buildSubgraph';
import { runCpmForwardPass } from '@/workers/cpmEngine';
import type { Task, TaskLink } from '@/types';

function task(id: string, start: string, finish: string, overrides: Partial<Task> = {}): Task {
  const duration =
    Math.round(
      (new Date(finish).getTime() - new Date(start).getTime()) / (24 * 60 * 60 * 1000),
    ) + 1;
  return {
    id,
    wbs: id,
    name: id,
    start,
    finish,
    duration,
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

function link(
  id: string,
  sourceId: string,
  targetId: string,
  type: TaskLink['type'] = 'FS',
): TaskLink {
  return { id, sourceId, targetId, type, lag: 0, isCritical: false };
}

/** Drive the exact pair a drag drives: build the subgraph, then run the pass. */
function preview(startTaskId: string, tasks: Task[], links: TaskLink[], newStartIso: string) {
  const subgraph = buildSubgraph(startTaskId, tasks, links);
  const { results, worstMilestone } = runCpmForwardPass(
    subgraph.tasks,
    subgraph.edges,
    startTaskId,
    newStartIso,
  );
  return {
    visited: subgraph.tasks.map((t) => t.id).sort(),
    byId: new Map(results.map((r) => [r.taskId, r])),
    worstMilestone,
  };
}

describe('#3535 mechanism 1 — dragging a task earlier propagates to its successors', () => {
  // A (3d, Mon–Wed) → FS → B (2d, Thu–Fri), zero slack. A is dragged one week
  // earlier, the ordinary "we finished early, pull it in" gesture.
  const tasks = [
    task('A', '2024-01-08', '2024-01-10'),
    task('B', '2024-01-11', '2024-01-12'),
  ];
  const links = [link('l1', 'A', 'B')];

  it('pulls a zero-slack successor back with its predecessor', () => {
    const { byId } = preview('A', tasks, links, '2024-01-01');

    expect(byId.get('A')!.earlyStart).toBe('2024-01-01');
    expect(byId.get('A')!.earlyFinish).toBe('2024-01-03');

    // Pre-fix CLIENT: es=2024-01-11 ef=2024-01-12 deltaDays=0 — `relaxForward`
    // only ever moved a successor LATER, so B stayed frozen at its stale slot.
    expect(byId.get('B')!.earlyStart).toBe('2024-01-04');
    expect(byId.get('B')!.earlyFinish).toBe('2024-01-05');
    expect(byId.get('B')!.deltaDays).toBe(-7);
  });

  it('reports a milestone that moves EARLIER, not only one that slips', () => {
    const withMilestone = [
      tasks[0],
      task('M', '2024-01-11', '2024-01-11', {
        isMilestone: true,
        name: 'Go Live',
        duration: 0,
      }),
    ];
    const { worstMilestone } = preview('A', withMilestone, [link('l1', 'A', 'M')], '2024-01-01');

    // Pre-fix: null — the milestone scan only accepted deltaDays > 0, so an
    // improvement the server WILL make produced no headline at all.
    expect(worstMilestone).not.toBeNull();
    expect(worstMilestone!.name).toBe('Go Live');
    expect(worstMilestone!.newFinish).toBe('2024-01-04');
    expect(worstMilestone!.deltaDays).toBe(-7);
  });
});

describe('#3535 mechanism 2 — a task gated on a summary is reached by the preview', () => {
  // A → C1 (leaf link). S is a summary whose children are C1 and C2, and
  // S → B is the link that gates B. The server expands S → B into C1 → B and
  // C2 → B before scheduling (`expand_summary_dependencies`); the client BFS'd
  // over literal TaskLink edges only, so B was never reached at all.
  const tasks = [
    task('A', '2024-01-01', '2024-01-03'),
    task('S', '2024-01-04', '2024-01-05', { isSummary: true }),
    task('C1', '2024-01-04', '2024-01-05', { parentId: 'S' }),
    task('C2', '2024-01-04', '2024-01-04', { parentId: 'S' }),
    task('B', '2024-01-08', '2024-01-09'),
  ];
  const links = [link('l1', 'A', 'C1'), link('l2', 'S', 'B')];

  it('reaches the summary-gated successor from a drag inside the phase', () => {
    const { visited } = preview('A', tasks, links, '2024-01-08');

    // Pre-fix CLIENT: ['A', 'C1'] — B absent, not miscalculated.
    expect(visited).toContain('B');
    expect(visited).toEqual(['A', 'B', 'C1']);
  });

  it('slips the summary-gated successor by the amount the server will', () => {
    const { byId } = preview('A', tasks, links, '2024-01-08');

    expect(byId.get('C1')!.earlyStart).toBe('2024-01-11');
    expect(byId.get('C1')!.earlyFinish).toBe('2024-01-12');

    // Pre-fix CLIENT: no result entry for B at all.
    const b = byId.get('B');
    expect(b, 'no preview result for B').toBeDefined();
    expect(b!.earlyStart).toBe('2024-01-15');
    expect(b!.earlyFinish).toBe('2024-01-16');
    expect(b!.deltaDays).toBe(7);
  });
});
