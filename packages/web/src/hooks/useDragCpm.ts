/**
 * Orchestrates the Gantt drag CPM preview (issue #19).
 *
 * - Subscribes to GanttEngine drag-task, drag-task-move, and drag-task-end events.
 * - Spawns a Web Worker for incremental CPM forward passes.
 * - Writes results into the Zustand drag store.
 * - Commits the drop via PATCH on release (with offline guard per rule 29).
 * - Handles Escape key cancellation (rule 28).
 *
 * Returns nothing — all side-effects go through the drag store and the
 * aria-live ref passed in by ScheduleView.
 *
 * Design rules enforced:
 * - Rule 55: engine.on() always returns an unsubscribe; called in cleanup
 * - Rule 56: uses engine coordinate system (leftToDate) not SVAR utils
 * - Rule 57: drag event `left` is canvas-origin; no viewport offset needed
 */

import { useEffect, useRef, type RefObject } from 'react';
import type { GanttEngine } from '@/features/schedule/engine';
import { leftToDate } from '@/features/schedule/engine';
import type { Task, TaskLink } from '@/types';
import type { RecalcMessage, ResultMessage } from '@/workers/cpmWorker.types';
import { useDragStore } from '@/stores/dragStore';
import { buildSubgraph } from '@/features/schedule/buildSubgraph';
import { createCpmWorker } from '@/workers/createCpmWorker';

interface UseDragCpmOptions {
  engine: GanttEngine | null;
  tasks: Task[];
  links: TaskLink[];
  /** DOM ref to the aria-live region — written directly to avoid re-render storms (rule 30). */
  ariaLiveRef: RefObject<HTMLDivElement | null>;
  /**
   * Ref that is `true` while a keyboard reschedule is active (issue #34).
   * When set, the Escape handler here yields to useKeyboardReschedule so the
   * same key does not double-cancel both the keyboard mode and a ghost drag.
   */
  keyboardModeRef?: RefObject<boolean>;
}

export function useDragCpm({
  engine,
  tasks,
  links,
  ariaLiveRef,
  keyboardModeRef,
}: UseDragCpmOptions): void {
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0);

  const startDrag = useDragStore((s) => s.startDrag);
  const updatePreview = useDragStore((s) => s.updatePreview);
  const commitDrag = useDragStore((s) => s.commitDrag);
  const cancelDrag = useDragStore((s) => s.cancelDrag);
  const setError = useDragStore((s) => s.setError);

  // Stable refs to avoid stale closures in engine event callbacks
  const tasksRef = useRef(tasks);
  const linksRef = useRef(links);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  useEffect(() => { linksRef.current = links; }, [links]);

  // Spawn/terminate worker with the engine lifecycle
  useEffect(() => {
    if (!engine) return;

    const worker = createCpmWorker();
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<ResultMessage>) => {
      const msg = event.data;
      if (msg.type !== 'RESULT') return;
      // Discard stale results (seq guard)
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
  }, [engine, updatePreview, ariaLiveRef]);

  // Wire engine events (rule 55: always unsubscribe)
  useEffect(() => {
    if (!engine) return;

    // drag-start: record dragged task, initialise state
    const offDragTask = engine.on('drag-task', (ev) => {
      startDrag(ev.id);
      seqRef.current = 0;
    });

    // drag-move: send RECALC to worker (rule 56/57: use engine.scales + leftToDate)
    const offDragMove = engine.on('drag-task-move', (ev) => {
      const worker = workerRef.current;
      if (!worker) return;

      const scaleData = engine.scales;
      if (!scaleData) return;

      // ev.left is canvas-origin (rule 57) — convert directly to date
      const newStartDate = leftToDate(ev.left, scaleData);
      const newStartIso = newStartDate.toISOString().slice(0, 10);

      const subgraph = buildSubgraph(ev.id, tasksRef.current, linksRef.current);
      const seq = ++seqRef.current;

      const msg: RecalcMessage = {
        type: 'RECALC',
        seq,
        draggedTaskId: ev.id,
        newStartIso,
        subgraph,
      };
      worker.postMessage(msg);
    });

    // drag-end: commit or cancel
    const offDragEnd = engine.on('drag-task-end', (ev) => {
      if (ev.cancelled) {
        cancelDrag();
        if (ariaLiveRef.current) ariaLiveRef.current.textContent = 'Drag cancelled';
        return;
      }

      // Offline guard (rule 29)
      if (!navigator.onLine) {
        cancelDrag();
        setError();
        return;
      }

      commitDrag();
    });

    // Escape key to cancel (rule 28).
    // Yields to useKeyboardReschedule when keyboard mode is active (issue #34).
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (keyboardModeRef?.current) return;
        const phase = useDragStore.getState().phase;
        if (phase === 'dragging') {
          cancelDrag();
          engine.cancelDrag();
          if (ariaLiveRef.current) ariaLiveRef.current.textContent = 'Drag cancelled';
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      offDragTask();
      offDragMove();
      offDragEnd();
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [engine, startDrag, updatePreview, commitDrag, cancelDrag, setError, ariaLiveRef, keyboardModeRef]);
}
