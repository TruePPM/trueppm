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
import { runCpmForwardPass } from './cpmEngine';

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
  send({ type: 'RESIZE_END' });
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

  // The data date is resident for the same reason the subgraph is: it cannot
  // change mid-drag, so DRAG_START carries it once and every frame reuses it
  // (issue #2813). A frame that lost it would preview a past drop the server
  // is about to floor.
  describe('resident data date', () => {
    it('applies the DRAG_START data date to every subsequent DRAG_MOVE', () => {
      send({
        type: 'DRAG_START',
        draggedTaskId: 'A',
        subgraph: SUBGRAPH_A,
        statusDate: '2025-02-03',
      });
      send({ type: 'DRAG_MOVE', seq: 1, newStartIso: '2025-01-13' });
      send({ type: 'DRAG_MOVE', seq: 2, newStartIso: '2025-01-14' });

      const a = lastResult()?.results.find((r) => r.taskId === 'A');
      expect(a?.earlyStart).toBe('2025-02-03');
    });

    it('releases the data date on DRAG_END so the next drag cannot inherit it', () => {
      send({
        type: 'DRAG_START',
        draggedTaskId: 'A',
        subgraph: SUBGRAPH_A,
        statusDate: '2025-02-03',
      });
      send({ type: 'DRAG_END' });
      send({ type: 'DRAG_START', draggedTaskId: 'A', subgraph: SUBGRAPH_A });
      send({ type: 'DRAG_MOVE', seq: 1, newStartIso: '2025-01-13' });

      const a = lastResult()?.results.find((r) => r.taskId === 'A');
      expect(a?.earlyStart).toBe('2025-01-13');
    });

    it('honors the data date carried on a stateless RECALC', () => {
      send({
        type: 'RECALC',
        seq: 7,
        draggedTaskId: 'A',
        newStartIso: '2025-01-13',
        subgraph: SUBGRAPH_A,
        statusDate: '2025-02-03',
      });

      const a = lastResult()?.results.find((r) => r.taskId === 'A');
      expect(a?.earlyStart).toBe('2025-02-03');
    });
  });

  // Resize (issue #4237) mirrors the drag protocol one-for-one: RESIZE_START /
  // RESIZE_MOVE / RESIZE_END in place of DRAG_START / DRAG_MOVE / DRAG_END.
  describe('resize protocol', () => {
    it('drops a RESIZE_MOVE that arrives with no resident subgraph', () => {
      send({ type: 'RESIZE_MOVE', seq: 1, newDurationDays: 8 });
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('does not post anything on RESIZE_START itself', () => {
      send({ type: 'RESIZE_START', resizedTaskId: 'A', subgraph: SUBGRAPH_A });
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('recomputes over the resident subgraph on RESIZE_MOVE after RESIZE_START', () => {
      send({ type: 'RESIZE_START', resizedTaskId: 'A', subgraph: SUBGRAPH_A });
      send({ type: 'RESIZE_MOVE', seq: 1, newDurationDays: 8 });

      const result = lastResult();
      expect(result?.type).toBe('RESULT');
      expect(result?.seq).toBe(1);
      expect(result?.draggedTaskId).toBe('A');
      const a = result?.results.find((r) => r.taskId === 'A');
      // Start is untouched; only the finish responds to the new duration.
      expect(a?.earlyStart).toBe('2025-01-06');
      expect(a?.earlyFinish).toBe('2025-01-15');
    });

    it('reuses the resident subgraph across multiple resize moves, echoing each seq', () => {
      send({ type: 'RESIZE_START', resizedTaskId: 'A', subgraph: SUBGRAPH_A });
      send({ type: 'RESIZE_MOVE', seq: 1, newDurationDays: 6 });
      send({ type: 'RESIZE_MOVE', seq: 2, newDurationDays: 8 });

      expect(postSpy).toHaveBeenCalledTimes(2);
      expect(lastResult()?.seq).toBe(2);
      expect(lastResult()?.results.find((r) => r.taskId === 'A')?.earlyFinish).toBe(
        '2025-01-15',
      );
    });

    it('drops resize moves after RESIZE_END clears the resident subgraph', () => {
      send({ type: 'RESIZE_START', resizedTaskId: 'A', subgraph: SUBGRAPH_A });
      send({ type: 'RESIZE_END' });
      postSpy.mockClear();

      send({ type: 'RESIZE_MOVE', seq: 5, newDurationDays: 10 });
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('does not let a RESIZE_MOVE act on a subgraph resident for a DRAG (cross-gesture guard)', () => {
      send({ type: 'DRAG_START', draggedTaskId: 'A', subgraph: SUBGRAPH_A });
      postSpy.mockClear();

      send({ type: 'RESIZE_MOVE', seq: 1, newDurationDays: 8 });
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('does not let a DRAG_MOVE act on a subgraph resident for a RESIZE (cross-gesture guard)', () => {
      send({ type: 'RESIZE_START', resizedTaskId: 'A', subgraph: SUBGRAPH_A });
      postSpy.mockClear();

      send({ type: 'DRAG_MOVE', seq: 1, newStartIso: '2025-01-13' });
      expect(postSpy).not.toHaveBeenCalled();
    });
  });
});

// --- calendar (#4170) ------------------------------------------------------

describe('cpmWorker calendar threading (#4170)', () => {
  // Wed 2025-01-15 is a holiday: a 5-day task dragged to Mon 01-13 works
  // 13, 14, 16, 17, 20 instead of finishing Fri 01-17.
  const HOLIDAY = { working_days: 0b0011111, exceptions: [{ start: '2025-01-15', end: '2025-01-15' }] };

  const finishOf = (id: string) => lastResult()?.results.find((r) => r.taskId === id)?.earlyFinish;

  it('keeps the DRAG_START calendar resident for every DRAG_MOVE', () => {
    send({ type: 'DRAG_START', draggedTaskId: 'A', subgraph: SUBGRAPH_A, calendar: HOLIDAY });
    send({ type: 'DRAG_MOVE', seq: 1, newStartIso: '2025-01-13' });
    expect(finishOf('A')).toBe('2025-01-20');
    send({ type: 'DRAG_MOVE', seq: 2, newStartIso: '2025-01-13' });
    expect(finishOf('A')).toBe('2025-01-20');
  });

  it('drops the calendar on DRAG_END, so the next gesture without one is Mon–Fri', () => {
    send({ type: 'DRAG_START', draggedTaskId: 'A', subgraph: SUBGRAPH_A, calendar: HOLIDAY });
    send({ type: 'DRAG_END' });
    send({ type: 'DRAG_START', draggedTaskId: 'A', subgraph: SUBGRAPH_A });
    send({ type: 'DRAG_MOVE', seq: 3, newStartIso: '2025-01-13' });
    expect(finishOf('A')).toBe('2025-01-17');
  });

  it('applies a RECALC message’s own calendar', () => {
    send({
      type: 'RECALC',
      seq: 4,
      draggedTaskId: 'A',
      newStartIso: '2025-01-13',
      subgraph: SUBGRAPH_A,
      calendar: HOLIDAY,
    });
    expect(finishOf('A')).toBe('2025-01-20');
  });

  it('keeps the RESIZE_START calendar resident for every RESIZE_MOVE', () => {
    // On a calendar with Wed 01-08 off, the server placed 5-day A at Mon 01-06 ..
    // Mon 01-13. Growing it to 6 days lands on Tue 01-14 (Mon–Fri would say 01-13).
    const midweek = { working_days: 0b0011111, exceptions: [{ start: '2025-01-08', end: '2025-01-08' }] };
    const onCalendar = { tasks: [{ ...TASK_A, earlyFinish: '2025-01-13', lateFinish: '2025-01-13' }], edges: [] };
    send({ type: 'RESIZE_START', resizedTaskId: 'A', subgraph: onCalendar, calendar: midweek });
    send({ type: 'RESIZE_MOVE', seq: 5, newDurationDays: 6 });
    expect(finishOf('A')).toBe('2025-01-14');
    send({ type: 'RESIZE_MOVE', seq: 6, newDurationDays: 6 });
    expect(finishOf('A')).toBe('2025-01-14');
  });
});

describe('cpmWorker cascade summary (#4314)', () => {
  /** Dragged task A feeds a chain of `n` one-day FS successors S1..Sn. */
  function chain(n: number): { tasks: CpmTask[]; edges: CpmEdge[] } {
    const tasks: CpmTask[] = [TASK_A];
    const edges: CpmEdge[] = [];
    let prev = 'A';
    // Consecutive working days after A's Fri 01-10 finish, so an undragged
    // chain already sits where the forward pass would put it (delta 0).
    const day = new Date(Date.UTC(2025, 0, 13));
    for (let i = 1; i <= n; i++) {
      const id = `S${i}`;
      const iso = day.toISOString().slice(0, 10);
      do day.setUTCDate(day.getUTCDate() + 1);
      while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
      tasks.push({
        ...TASK_A,
        id,
        name: id,
        earlyStart: iso,
        earlyFinish: iso,
        lateFinish: iso,
        durationDays: 1,
      });
      edges.push({ sourceId: prev, targetId: id, type: 'FS', lag: 0 } as CpmEdge);
      prev = id;
    }
    return { tasks, edges };
  }

  it('counts every moved downstream task past the 10-bar cap and reports the latest finish', () => {
    send({
      type: 'RECALC',
      seq: 1,
      draggedTaskId: 'A',
      newStartIso: '2025-01-20',
      subgraph: chain(14),
    });
    const r = lastResult();
    expect(r?.results).toHaveLength(10);
    expect(r?.overflowCount).toBeGreaterThan(0);
    // Dragged task excluded: 14 successors, all shifted a week.
    expect(r?.movedCount).toBe(14);
    expect(r?.movedCount).toBeGreaterThan(10);
    // The last link of the chain finishes latest; the preview carries only 10
    // results, so maxFinish must have been summarized before the cap.
    const all = runCpmForwardPass(chain(14).tasks, chain(14).edges, 'A', '2025-01-20');
    const latest = all.results.map((x) => x.earlyFinish).sort().at(-1);
    expect(all.results.filter((x) => x.taskId !== 'A' && x.deltaDays !== 0)).toHaveLength(14);
    expect(r?.maxFinish).toBe(latest);
    expect(r?.results.map((x) => x.earlyFinish).sort().at(-1)).not.toBe(latest);
  });

  it('does not count a task whose deltaDays is 0', () => {
    // Drag A to its own start: nothing downstream moves.
    send({
      type: 'RECALC',
      seq: 2,
      draggedTaskId: 'A',
      newStartIso: '2025-01-06',
      subgraph: chain(3),
    });
    const r = lastResult();
    expect(r?.movedCount).toBe(0);
    expect(r?.maxFinish).not.toBeNull();
  });
});
