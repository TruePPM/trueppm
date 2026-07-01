/**
 * Performance guard for the native-TS drag-preview CPM worker.
 *
 * ADR-0015 amendment (Issue #19) keeps the Gantt drag-preview on a native
 * TypeScript forward pass rather than migrating to the Rust WASM build.
 * This test enforces the frame-budget commitment made in that amendment:
 * a 1000-task FS chain preview must complete in < 33 ms p95 (≥30 fps).
 *
 * When this test fails, the amendment's trigger condition is met — consider
 * executing the WASM migration path documented in ADR-0015.
 */
import { describe, it, expect } from 'vitest';
import { runCpmForwardPass } from './cpmEngine';
import type { CpmTask, CpmEdge } from './cpmWorker.types';

function buildFsChain(size: number): { tasks: CpmTask[]; edges: CpmEdge[] } {
  const tasks: CpmTask[] = [];
  const edges: CpmEdge[] = [];
  const startMs = new Date('2026-01-01').getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  for (let i = 0; i < size; i++) {
    const s = new Date(startMs + i * dayMs).toISOString().slice(0, 10);
    const f = new Date(startMs + (i + 1) * dayMs).toISOString().slice(0, 10);
    tasks.push({
      id: `t${i}`,
      earlyStart: s,
      earlyFinish: f,
      lateFinish: f,
      durationDays: 1,
      isMilestone: false,
      name: `Task ${i}`,
    });
    if (i > 0) edges.push({ sourceId: `t${i - 1}`, targetId: `t${i}`, type: 'FS', lag: 0 });
  }
  return { tasks, edges };
}

describe('cpmEngine perf guard (ADR-0015 amendment)', () => {
  it('runs a 1000-task FS chain preview in < 33ms p95', () => {
    const { tasks, edges } = buildFsChain(1000);
    const timings: number[] = [];
    // Warm-up (discard) — V8 JIT and map allocation.
    for (let i = 0; i < 3; i++) runCpmForwardPass(tasks, edges, 't0', '2026-01-05');

    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      runCpmForwardPass(tasks, edges, 't0', '2026-01-05');
      timings.push(performance.now() - t);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(timings.length * 0.95)];
    expect(p95).toBeLessThan(33);
  });
});
