/**
 * Web Worker entry point for incremental CPM forward pass.
 *
 * Receives RECALC messages from the main thread, runs the CPM engine,
 * and posts RESULT messages back. Stale results are identified by the
 * monotonically-increasing `seq` number — the main thread discards any
 * result whose seq is lower than the last one it sent.
 *
 * The worker is instantiated once per ScheduleView mount (via useDragCpm).
 */

import { runCpmForwardPass } from './cpmEngine';
import type { RecalcMessage, ResultMessage } from './cpmWorker.types';

self.onmessage = (event: MessageEvent<RecalcMessage>) => {
  const msg = event.data;
  if (msg.type !== 'RECALC') return;

  const { seq, draggedTaskId, newStartIso, subgraph } = msg;

  const { results, worstMilestone } = runCpmForwardPass(
    subgraph.tasks,
    subgraph.edges,
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
};
