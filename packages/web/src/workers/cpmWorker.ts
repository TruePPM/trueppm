/**
 * Web Worker entry point for incremental CPM forward pass.
 *
 * Protocol (issue #1524): the main thread sends DRAG_START once with the dragged
 * task's downstream subgraph, then a DRAG_MOVE per animation frame carrying only
 * the changed start date, and finally DRAG_END. The subgraph is topologically
 * invariant for the whole drag (a drag moves a bar's date, not the network), so
 * the worker keeps it resident between DRAG_START and DRAG_END and each move
 * reruns the pass over the cached graph instead of re-parsing a fresh payload.
 *
 * RESULT messages carry the same monotonically-increasing `seq` the DRAG_MOVE
 * did — the main thread discards any result whose seq is lower than the last one
 * it sent, so out-of-order frames never regress the preview.
 *
 * The worker is instantiated once per ScheduleView mount (via useDragCpm).
 */

import { runCpmForwardPass } from './cpmEngine';
import type {
  CpmEdge,
  CpmTask,
  ResultMessage,
  WorkerRequest,
} from './cpmWorker.types';

// Resident subgraph for the active drag. Set on DRAG_START, reused by every
// DRAG_MOVE, cleared on DRAG_END. Null between drags.
let residentTasks: CpmTask[] | null = null;
let residentEdges: CpmEdge[] | null = null;
let residentDraggedTaskId: string | null = null;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'DRAG_START':
      residentTasks = msg.subgraph.tasks;
      residentEdges = msg.subgraph.edges;
      residentDraggedTaskId = msg.draggedTaskId;
      return;

    case 'DRAG_END':
      residentTasks = null;
      residentEdges = null;
      residentDraggedTaskId = null;
      return;

    case 'DRAG_MOVE': {
      // Drop a move with no resident subgraph (e.g. a DRAG_MOVE that raced ahead
      // of DRAG_START across a remount) rather than recomputing over stale state.
      if (!residentTasks || !residentEdges || !residentDraggedTaskId) return;

      postResult(
        residentTasks,
        residentEdges,
        residentDraggedTaskId,
        msg.newStartIso,
        msg.seq,
      );
      return;
    }

    case 'RECALC':
      // Stateless one-shot (keyboard reschedule, issue #34): compute from the
      // message's own subgraph without touching resident drag state.
      postResult(
        msg.subgraph.tasks,
        msg.subgraph.edges,
        msg.draggedTaskId,
        msg.newStartIso,
        msg.seq,
      );
      return;
  }
};

/** Run the forward pass, cap the preview, and post the RESULT back. */
function postResult(
  tasks: CpmTask[],
  edges: CpmEdge[],
  draggedTaskId: string,
  newStartIso: string,
  seq: number,
): void {
  const { results, worstMilestone } = runCpmForwardPass(
    tasks,
    edges,
    draggedTaskId,
    newStartIso,
  );

  // Cap at 10 visible preview bars; report overflow count for the "+N more" label.
  const PREVIEW_CAP = 10;
  const overflowCount = Math.max(0, results.length - PREVIEW_CAP);
  const cappedResults = results.slice(0, PREVIEW_CAP);

  const response: ResultMessage = {
    type: 'RESULT',
    seq,
    draggedTaskId,
    results: cappedResults,
    worstMilestone,
    overflowCount,
  };

  self.postMessage(response);
}
