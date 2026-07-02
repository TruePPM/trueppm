/**
 * Unit tests for the CPM worker's message protocol (issue #1524).
 *
 * The worker keeps the dragged task's subgraph resident between DRAG_START and
 * DRAG_END so each DRAG_MOVE reuses it instead of shipping a fresh subgraph per
 * frame. These tests drive `self.onmessage` directly (the worker registers it at
 * import) and assert the stateful behavior: START stores, MOVE reuses, END
 * clears, a MOVE with no resident subgraph is dropped, and RECALC stays a
 * stateless one-shot that never touches resident state.
 */

import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';
import type {
  CpmEdge,
  CpmTask,
  ResultMessage,
  WorkerRequest,
} from './cpmWorker.types';

// Importing the module registers `self.onmessage` as a side effect.
import './cpmWorker';

// --- fixtures --------------------------------------------------------------

const TASK_A: CpmTask = {
  id: 'A',
  earlyStart: '2025-01-06',
  earlyFinish: '2025-01-10',
  lateFinish: '2025-01-10',
  durationDays: 5,
  isMilestone: false,
  name: 'A',
};

const SUBGRAPH_A = { tasks: [TASK_A] as CpmTask[], edges: [] as CpmEdge[] };

const TASK_Z: CpmTask = { ...TASK_A, id: 'Z', name: 'Z' };
const SUBGRAPH_Z = { tasks: [TASK_Z] as CpmTask[], edges: [] as CpmEdge[] };

// --- harness ---------------------------------------------------------------

const postSpy = vi.spyOn(self, 'postMessage').mockImplementation(() => {});

/** Deliver a message to the worker's registered onmessage handler. */
function send(data: WorkerRequest): void {
  const handler = self.onmessage as ((ev: MessageEvent) => void) | null;
  handler?.(new MessageEvent('message', { data }));
}

/** The last RESULT posted back, or undefined if none. */
function lastResult(): ResultMessage | undefined {
  const call = postSpy.mock.calls.at(-1);
  return call?.[0] as ResultMessage | undefined;
}

beforeEach(() => {
  // Clear any resident state carried over from a prior test, then reset the spy.
  send({ type: 'DRAG_END' });
  postSpy.mockClear();
});

afterAll(() => {
  postSpy.mockRestore();
});

// --- tests -----------------------------------------------------------------

describe('cpmWorker protocol', () => {
  it('drops a DRAG_MOVE that arrives with no resident subgraph', () => {
    send({ type: 'DRAG_MOVE', seq: 1, newStartIso: '2025-01-13' });
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('does not post anything on DRAG_START itself', () => {
    send({ type: 'DRAG_START', draggedTaskId: 'A', subgraph: SUBGRAPH_A });
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('recomputes over the resident subgraph on DRAG_MOVE after DRAG_START', () => {
    send({ type: 'DRAG_START', draggedTaskId: 'A', subgraph: SUBGRAPH_A });
    send({ type: 'DRAG_MOVE', seq: 1, newStartIso: '2025-01-13' });

    const result = lastResult();
    expect(result?.type).toBe('RESULT');
    expect(result?.seq).toBe(1);
    expect(result?.draggedTaskId).toBe('A');
    // The dragged task moved to the new start (proves the pass actually ran).
    const a = result?.results.find((r) => r.taskId === 'A');
    expect(a?.earlyStart).toBe('2025-01-13');
  });

  it('reuses the resident subgraph across multiple moves, echoing each seq', () => {
    send({ type: 'DRAG_START', draggedTaskId: 'A', subgraph: SUBGRAPH_A });
    send({ type: 'DRAG_MOVE', seq: 1, newStartIso: '2025-01-13' });
    send({ type: 'DRAG_MOVE', seq: 2, newStartIso: '2025-01-14' });

    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(lastResult()?.seq).toBe(2);
    expect(lastResult()?.results.find((r) => r.taskId === 'A')?.earlyStart).toBe(
      '2025-01-14',
    );
  });

  it('drops moves after DRAG_END clears the resident subgraph', () => {
    send({ type: 'DRAG_START', draggedTaskId: 'A', subgraph: SUBGRAPH_A });
    send({ type: 'DRAG_END' });
    postSpy.mockClear();

    send({ type: 'DRAG_MOVE', seq: 5, newStartIso: '2025-01-20' });
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('handles a stateless RECALC without any DRAG_START', () => {
    send({
      type: 'RECALC',
      seq: 9,
      draggedTaskId: 'A',
      newStartIso: '2025-01-13',
      subgraph: SUBGRAPH_A,
    });

    const result = lastResult();
    expect(result?.type).toBe('RESULT');
    expect(result?.seq).toBe(9);
    expect(result?.draggedTaskId).toBe('A');
  });

  it('RECALC does not disturb the resident drag subgraph', () => {
    // A drag is in progress (task A resident) ...
    send({ type: 'DRAG_START', draggedTaskId: 'A', subgraph: SUBGRAPH_A });
    // ... a stateless RECALC for a *different* task fires (keyboard path) ...
    send({
      type: 'RECALC',
      seq: 100,
      draggedTaskId: 'Z',
      newStartIso: '2025-02-01',
      subgraph: SUBGRAPH_Z,
    });
    postSpy.mockClear();

    // ... the next drag move must still resolve against the resident task A.
    send({ type: 'DRAG_MOVE', seq: 3, newStartIso: '2025-01-13' });
    expect(lastResult()?.draggedTaskId).toBe('A');
  });
});
