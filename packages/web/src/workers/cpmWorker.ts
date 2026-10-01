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
 * Resize (issue #4237) mirrors the drag protocol one-for-one: RESIZE_START /
 * RESIZE_MOVE / RESIZE_END in place of DRAG_START / DRAG_MOVE / DRAG_END. The
 * only difference is what moves — a resize holds the task's start fixed and
 * changes its working-day duration instead of its start date — so the two
 * protocols share one resident subgraph slot (only one gesture is ever live
 * at a time) and one RESULT shape.
 *
 * The worker is instantiated once per ScheduleView mount (via useDragCpm).
 */

import { runCpmForwardPass, runCpmResizeForwardPass } from './cpmEngine';
import type {
  CpmEdge,
  CpmTask,
  PreviewMilestone,
  PreviewTaskResult,
  ResultMessage,
  WorkerRequest,
} from './cpmWorker.types';

// Resident subgraph for the active drag OR resize (issue #4237 — the two
// gestures share one resident slot because only one can be live at a time:
// a single pointer drives either a bar body or a resize handle, never both).
// Set on DRAG_START/RESIZE_START, reused by every *_MOVE, cleared on
// DRAG_END/RESIZE_END. Null between gestures.
let residentTasks: CpmTask[] | null = null;
let residentEdges: CpmEdge[] | null = null;
let residentTargetTaskId: string | null = null;
// Which gesture the resident subgraph belongs to — a MOVE message for the
// other gesture is dropped rather than misapplied (e.g. a stray RESIZE_MOVE
// racing in after DRAG_END cleared the slot but before a fresh RESIZE_START
// landed would otherwise read as a resize of the dragged task).
let residentMode: 'drag' | 'resize' | null = null;
// The project's data date for the active drag (issue #2813). Resident for the
// same reason the subgraph is: it cannot change mid-drag. Always null for a
// resize — that floor clamps the DRAGGED task's start, and a resize never
// moves its task's start.
let residentStatusDate: string | null = null;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'DRAG_START':
      residentTasks = msg.subgraph.tasks;
      residentEdges = msg.subgraph.edges;
      residentTargetTaskId = msg.draggedTaskId;
      residentStatusDate = msg.statusDate ?? null;
      residentMode = 'drag';
      return;

    case 'RESIZE_START':
      residentTasks = msg.subgraph.tasks;
      residentEdges = msg.subgraph.edges;
      residentTargetTaskId = msg.resizedTaskId;
      residentStatusDate = null;
      residentMode = 'resize';
      return;

    case 'DRAG_END':
    case 'RESIZE_END':
      residentTasks = null;
      residentEdges = null;
      residentTargetTaskId = null;
      residentStatusDate = null;
      residentMode = null;
      return;

    case 'DRAG_MOVE': {
      // Drop a move with no resident subgraph, or one belonging to the other
      // gesture (e.g. a DRAG_MOVE that raced ahead of DRAG_START across a
      // remount), rather than recomputing over stale or mismatched state.
      if (!residentTasks || !residentEdges || !residentTargetTaskId || residentMode !== 'drag') {
        return;
      }

      postResult(
        residentTasks,
        residentEdges,
        residentTargetTaskId,
        msg.newStartIso,
        msg.seq,
        residentStatusDate,
      );
      return;
    }

    case 'RESIZE_MOVE': {
      if (
        !residentTasks ||
        !residentEdges ||
        !residentTargetTaskId ||
        residentMode !== 'resize'
      ) {
        return;
      }

      postResizeResult(residentTasks, residentEdges, residentTargetTaskId, msg.newDurationDays, msg.seq);
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
        msg.statusDate ?? null,
      );
      return;
  }
};

/** Cap the preview, shape the RESULT, and post it back — shared by both gestures. */
function emitResult(
  taskId: string,
  results: PreviewTaskResult[],
  worstMilestone: PreviewMilestone | null,
  seq: number,
): void {
  // Cap at 10 visible preview bars; report overflow count for the "+N more" label.
  const PREVIEW_CAP = 10;
  const overflowCount = Math.max(0, results.length - PREVIEW_CAP);
  const cappedResults = results.slice(0, PREVIEW_CAP);

  const response: ResultMessage = {
    type: 'RESULT',
    seq,
    draggedTaskId: taskId,
    results: cappedResults,
    worstMilestone,
    overflowCount,
  };

  self.postMessage(response);
}

/** Run the drag forward pass and post the RESULT back. */
function postResult(
  tasks: CpmTask[],
  edges: CpmEdge[],
  draggedTaskId: string,
  newStartIso: string,
  seq: number,
  statusDate: string | null,
): void {
  const { results, worstMilestone } = runCpmForwardPass(
    tasks,
    edges,
    draggedTaskId,
    newStartIso,
    statusDate,
  );
  emitResult(draggedTaskId, results, worstMilestone, seq);
}

/** Run the resize forward pass and post the RESULT back (issue #4237). */
function postResizeResult(
  tasks: CpmTask[],
  edges: CpmEdge[],
  resizedTaskId: string,
  newDurationDays: number,
  seq: number,
): void {
  const { results, worstMilestone } = runCpmResizeForwardPass(
    tasks,
    edges,
    resizedTaskId,
    newDurationDays,
  );
  emitResult(resizedTaskId, results, worstMilestone, seq);
}
