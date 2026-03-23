/**
 * Orchestrates the Gantt drag CPM preview (issue #19).
 *
 * - Intercepts SVAR drag-start, drag-move, drag-end, and drag-cancel events.
 * - Spawns a Web Worker for incremental CPM forward passes.
 * - Writes results into the Zustand drag store.
 * - Commits the drop via PATCH on release (with offline guard per rule 29).
 * - Handles Escape key cancellation (rule 28).
 *
 * Returns nothing — all side-effects go through the drag store and the
 * aria-live ref passed in by GanttView.
 */

import { useEffect, useRef, type RefObject } from 'react';
import type { IApi } from '@svar-ui/gantt-store';
import type { Task, TaskLink } from '@/types';
import type { RecalcMessage, ResultMessage } from '@/workers/cpmWorker.types';
import { useDragStore } from '@/stores/dragStore';
import { buildSubgraph } from '@/features/gantt/buildSubgraph';
import { dateFromCanvasLeft } from '@/features/gantt/ganttUtils';
import { createCpmWorker } from '@/workers/createCpmWorker';

interface UseDragCpmOptions {
  ganttApi: IApi | null;
  tasks: Task[];
  links: TaskLink[];
  /** DOM ref to the aria-live region — written directly to avoid re-render storms (rule 30). */
  ariaLiveRef: RefObject<HTMLDivElement | null>;
}

export function useDragCpm({
  ganttApi,
  tasks,
  links,
  ariaLiveRef,
}: UseDragCpmOptions): void {
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0);

  const startDrag = useDragStore((s) => s.startDrag);
  const updatePreview = useDragStore((s) => s.updatePreview);
  const commitDrag = useDragStore((s) => s.commitDrag);
  const cancelDrag = useDragStore((s) => s.cancelDrag);
  const setError = useDragStore((s) => s.setError);

  // Stable refs to avoid stale closures in SVAR intercept callbacks
  const tasksRef = useRef(tasks);
  const linksRef = useRef(links);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  useEffect(() => { linksRef.current = links; }, [links]);

  // Spawn/terminate worker with the ganttApi lifecycle
  useEffect(() => {
    if (!ganttApi) return;

    const worker = createCpmWorker();
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<ResultMessage>) => {
      const msg = event.data;
      if (msg.type !== 'RESULT') return;
      // Discard stale results (rule 30 — seq guard)
      if (msg.seq < seqRef.current) return;

      updatePreview(msg.results, msg.worstMilestone, msg.overflowCount);

      // Update aria-live directly via DOM ref (rule 30)
      if (ariaLiveRef.current && msg.worstMilestone) {
        const { name, deltaDays } = msg.worstMilestone;
        ariaLiveRef.current.textContent =
          deltaDays > 0
            ? `${name} slips ${deltaDays} day${deltaDays === 1 ? '' : 's'}`
            : `${name} on schedule`;
      }
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [ganttApi, updatePreview, ariaLiveRef]);

  // Wire SVAR intercepts
  useEffect(() => {
    if (!ganttApi) return;

    // drag-start: record dragged task, initialise state
    // Note: SVAR's intercept() returns void — no unsubscribe mechanism is exposed.
    ganttApi.intercept('drag-task', (ev: { id: string | number }) => {
      const taskId = String(ev.id);
      startDrag(taskId);
      seqRef.current = 0;
    });

    // drag-move: send RECALC to worker
    ganttApi.intercept(
      'drag-task-move',
      (ev: { id: string | number; left: number }) => {
        const worker = workerRef.current;
        const api = ganttApi;
        if (!worker) return;

        const taskId = String(ev.id);
        const scaleData = api.getState()._scales;
        if (!scaleData) return;

        const newStartDate = dateFromCanvasLeft(ev.left, scaleData);
        const newStartIso = newStartDate.toISOString().slice(0, 10);

        const subgraph = buildSubgraph(taskId, tasksRef.current, linksRef.current);
        const seq = ++seqRef.current;

        const msg: RecalcMessage = {
          type: 'RECALC',
          seq,
          draggedTaskId: taskId,
          newStartIso,
          subgraph,
        };
        worker.postMessage(msg);
      },
    );

    // drag-end: commit or cancel
    ganttApi.intercept(
      'drag-task-end',
      (ev: { id: string | number; left: number; cancelled?: boolean }) => {
        if (ev.cancelled) {
          cancelDrag();
          if (ariaLiveRef.current) ariaLiveRef.current.textContent = 'Drag cancelled';
          return;
        }

        // Offline guard (rule 29)
        if (!navigator.onLine) {
          cancelDrag();
          // Toast is handled at the GanttView level via store phase subscription
          setError();
          return;
        }

        commitDrag();
        // The actual PATCH is dispatched by GanttView watching phase === 'committing'
      },
    );

    // Escape key to cancel (rule 28)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const phase = useDragStore.getState().phase;
        if (phase === 'dragging') {
          cancelDrag();
          void ganttApi.exec?.('drag-task-cancel', {});
          if (ariaLiveRef.current) ariaLiveRef.current.textContent = 'Drag cancelled';
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [ganttApi, startDrag, updatePreview, commitDrag, cancelDrag, setError, ariaLiveRef]);
}
