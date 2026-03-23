import { describe, it, expect } from 'vitest';
import { runCpmForwardPass } from './cpmEngine';
import type { CpmTask, CpmEdge } from './cpmWorker.types';

// Helper: build a task with sensible defaults
function task(
  id: string,
  earlyStart: string,
  earlyFinish: string,
  opts: Partial<CpmTask> = {},
): CpmTask {
  return {
    id,
    earlyStart,
    earlyFinish,
    lateFinish: opts.lateFinish ?? earlyFinish, // zero float by default
    durationDays:
      opts.durationDays ??
      Math.round(
        (new Date(earlyFinish).getTime() - new Date(earlyStart).getTime()) /
          (24 * 60 * 60 * 1000),
      ) + 1,
    isMilestone: opts.isMilestone ?? false,
    name: opts.name ?? id,
  };
}

function edge(sourceId: string, targetId: string, type: CpmEdge['type'] = 'FS'): CpmEdge {
  return { sourceId, targetId, type };
}

describe('runCpmForwardPass', () => {
  it('moves a single task to the new start with correct finish', () => {
    const tasks: CpmTask[] = [task('A', '2025-01-06', '2025-01-10')]; // 5 days
    const { results } = runCpmForwardPass(tasks, [], 'A', '2025-01-13');

    expect(results).toHaveLength(1);
    expect(results[0].earlyStart).toBe('2025-01-13');
    expect(results[0].earlyFinish).toBe('2025-01-17'); // 5 days inclusive
  });

  it('propagates FS dependency to downstream task', () => {
    // A (5d) → FS → B (3d)
    // Drag A to Jan 13 → A finishes Jan 17 → B starts Jan 18 → finishes Jan 20
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-10'),
      task('B', '2025-01-11', '2025-01-13'), // original: starts after A
    ];
    const edges: CpmEdge[] = [edge('A', 'B', 'FS')];

    const { results } = runCpmForwardPass(tasks, edges, 'A', '2025-01-13');
    const a = results.find((r) => r.taskId === 'A')!;
    const b = results.find((r) => r.taskId === 'B')!;

    expect(a.earlyStart).toBe('2025-01-13');
    expect(a.earlyFinish).toBe('2025-01-17');
    expect(b.earlyStart).toBe('2025-01-18');
    expect(b.earlyFinish).toBe('2025-01-20');
  });

  it('propagates SS dependency correctly', () => {
    // A (5d) → SS → B (3d): B starts when A starts
    // Drag A to Jan 13 → B starts Jan 13 → finishes Jan 15
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-10'),
      task('B', '2025-01-06', '2025-01-08'),
    ];
    const { results } = runCpmForwardPass(
      tasks,
      [edge('A', 'B', 'SS')],
      'A',
      '2025-01-13',
    );
    const b = results.find((r) => r.taskId === 'B')!;
    expect(b.earlyStart).toBe('2025-01-13');
    expect(b.earlyFinish).toBe('2025-01-15');
  });

  it('propagates FF dependency correctly', () => {
    // A (5d, finishes Jan 17) → FF → B (3d): B finishes no earlier than A
    // B start = A.finish - B.duration + 1 = Jan 17 - 3 + 1 = Jan 15
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-10'),
      task('B', '2025-01-06', '2025-01-08'), // original 3 days
    ];
    const { results } = runCpmForwardPass(
      tasks,
      [edge('A', 'B', 'FF')],
      'A',
      '2025-01-13',
    );
    const b = results.find((r) => r.taskId === 'B')!;
    // A finishes Jan 17; B should finish Jan 17 (FF), starting Jan 15
    expect(b.earlyFinish).toBe('2025-01-17');
  });

  it('computes deltaDays correctly for slipping task', () => {
    // A originally finishes Jan 10; dragged to finish Jan 17 → delta = +7
    const tasks: CpmTask[] = [task('A', '2025-01-06', '2025-01-10')];
    const { results } = runCpmForwardPass(tasks, [], 'A', '2025-01-13');
    expect(results[0].deltaDays).toBe(7);
  });

  it('marks task as critical when new finish exceeds lateFinish', () => {
    // A has lateFinish Jan 15; after drag it finishes Jan 17 → critical
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-10', { lateFinish: '2025-01-15' }),
    ];
    const { results } = runCpmForwardPass(tasks, [], 'A', '2025-01-13');
    expect(results[0].isCritical).toBe(true);
  });

  it('does not mark task as critical when finish is within float', () => {
    // A has lateFinish Jan 20; after drag it finishes Jan 17 — still on track
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-10', { lateFinish: '2025-01-20' }),
    ];
    const { results } = runCpmForwardPass(tasks, [], 'A', '2025-01-13');
    expect(results[0].isCritical).toBe(false);
  });

  it('identifies worst milestone', () => {
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-10'),
      task('M1', '2025-01-11', '2025-01-11', { isMilestone: true, name: 'Go Live', durationDays: 1 }),
    ];
    const { worstMilestone } = runCpmForwardPass(
      tasks,
      [edge('A', 'M1', 'FS')],
      'A',
      '2025-01-13',
    );
    expect(worstMilestone).not.toBeNull();
    expect(worstMilestone?.name).toBe('Go Live');
    expect(worstMilestone?.deltaDays).toBe(7); // Jan 18 vs Jan 11
  });

  it('returns null worstMilestone when no milestones present', () => {
    const tasks: CpmTask[] = [task('A', '2025-01-06', '2025-01-10')];
    const { worstMilestone } = runCpmForwardPass(tasks, [], 'A', '2025-01-13');
    expect(worstMilestone).toBeNull();
  });

  it('handles chains of 3+ tasks', () => {
    // A (2d) → B (2d) → C (2d); drag A by +7
    const tasks: CpmTask[] = [
      task('A', '2025-01-06', '2025-01-07'),
      task('B', '2025-01-08', '2025-01-09'),
      task('C', '2025-01-10', '2025-01-11'),
    ];
    const edges: CpmEdge[] = [edge('A', 'B'), edge('B', 'C')];
    const { results } = runCpmForwardPass(tasks, edges, 'A', '2025-01-13');
    const c = results.find((r) => r.taskId === 'C')!;
    // A: Jan 13–14, B: Jan 15–16, C: Jan 17–18
    expect(c.earlyStart).toBe('2025-01-17');
    expect(c.earlyFinish).toBe('2025-01-18');
  });
});
