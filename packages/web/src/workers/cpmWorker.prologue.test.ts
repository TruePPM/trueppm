/**
 * #2857 — the drag-preview worker builds the graph prologue (state template,
 * predecessor map, topological order) once per gesture, not once per move.
 * Re-inlining the prologue into the per-move path makes the call counts below
 * fail. The prologue is observed through `prepareCpmForwardPass`, the single
 * entry point that builds it.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { CpmEdge, CpmTask, WorkerRequest } from './cpmWorker.types';

vi.mock('./cpmEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cpmEngine')>();
  return { ...actual, prepareCpmForwardPass: vi.fn(actual.prepareCpmForwardPass) };
});

import * as engine from './cpmEngine';
import './cpmWorker';

const mk = (id: string, start: string, finish: string): CpmTask => ({
  id,
  earlyStart: start,
  earlyFinish: finish,
  lateFinish: finish,
  durationDays: 5,
  isMilestone: false,
  name: id,
});
const tasks = [mk('A', '2025-01-06', '2025-01-10'), mk('B', '2025-01-13', '2025-01-17')];
const edges: CpmEdge[] = [{ sourceId: 'A', targetId: 'B', type: 'FS', lag: 0 }];
const subgraph = { tasks, edges };

const postSpy = vi.spyOn(self, 'postMessage').mockImplementation(() => {});
function send(data: WorkerRequest): void {
  (self.onmessage as (ev: MessageEvent) => void)(new MessageEvent('message', { data }));
}
const prepare = vi.mocked(engine.prepareCpmForwardPass);

beforeEach(() => {
  send({ type: 'DRAG_END' });
  prepare.mockClear();
  postSpy.mockClear();
});

describe('cpmWorker prologue reuse (#2857)', () => {
  it('prepares once for DRAG_START + 20 DRAG_MOVEs', () => {
    send({ type: 'DRAG_START', draggedTaskId: 'A', subgraph });
    for (let i = 0; i < 20; i++) {
      send({ type: 'DRAG_MOVE', seq: i, newStartIso: `2025-01-${String(7 + i).padStart(2, '0')}` });
    }
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledTimes(20);
  });

  it('prepares once for RESIZE_START + N RESIZE_MOVEs', () => {
    send({ type: 'RESIZE_START', resizedTaskId: 'A', subgraph });
    for (let i = 1; i <= 5; i++) send({ type: 'RESIZE_MOVE', seq: i, newDurationDays: i });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledTimes(5);
  });

  it('RECALC stays stateless and does not use the resident prologue', () => {
    send({ type: 'RECALC', seq: 1, draggedTaskId: 'A', newStartIso: '2025-01-08', subgraph });
    expect(prepare).not.toHaveBeenCalled();
    expect(postSpy).toHaveBeenCalledTimes(1);
  });
});
