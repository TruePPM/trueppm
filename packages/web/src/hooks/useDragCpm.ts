/**
 * Orchestrates the Gantt drag/resize CPM preview (issue #19; resize #4237).
 *
 * - Subscribes to GanttEngine drag-task / drag-task-move / drag-task-end AND
 *   resize-task / resize-task-move / resize-task-end events.
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
import { dragDropStartIso, leftToDate } from '@/features/schedule/engine';
import type { Task, TaskLink } from '@/types';
import type {
  DragEndMessage,
  DragMoveMessage,
  DragStartMessage,
  ResizeEndMessage,
  ResizeMoveMessage,
  ResizeStartMessage,
  ResultMessage,
} from '@/workers/cpmWorker.types';
import { useDragStore } from '@/stores/dragStore';
import { buildSubgraph } from '@/features/schedule/buildSubgraph';
import {
  isPinnedByActuals,
  PINNED_DRAG_EXPLANATION,
} from '@/features/schedule/pinnedByActuals';
import { milestoneDeltaAnnouncement } from '@/features/schedule/milestoneDeltaAnnouncement';
import {
  MON_FRI_MASK,
  resizeMoveFinishIso,
  workingDaysInclusive,
} from '@/features/schedule/useScheduleCommit';
import { createCpmWorker } from '@/workers/createCpmWorker';
import { isTypingInInput } from '@/hooks/useGlobalShortcut';

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
  /**
   * The project's data date (`Project.status_date`), or null to resolve it to
   * today the way the server does (ADR-0132 §1, issue #2813). Floors the
   * previewed start of the dragged task, so a drop into the past previews the
   * date the server will actually commit.
   */
  statusDate?: string | null;
  /**
   * The project's effective working-day bitmask (`effective_calendar.working_days`,
   * ADR-0441 / #1987), or null/undefined to fall back to Mon–Fri. Drives the
   * resize preview's pixel→duration conversion (issue #4237) — the same mask
   * `useScheduleCommit`'s resize-commit path uses, so the live cascade and the
   * eventual PATCH never disagree about how many working days a drag spans.
   */
  workingDaysMask?: number | null;
}

export function useDragCpm({
  engine,
  tasks,
  links,
  ariaLiveRef,
  keyboardModeRef,
  statusDate,
  workingDaysMask,
}: UseDragCpmOptions): void {
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0);
  // Which gesture is live — read only by the Escape handler so its aria-live
  // text matches the gesture it is cancelling (#4237). The store's `phase`
  // doesn't distinguish drag from resize (both read 'dragging'), and that is
  // correct for everything else that reads it (PreviewOverlay, the worker
  // RESULT handler) — only the cancel announcement's wording needs to know.
  const activeGestureRef = useRef<'drag' | 'resize' | null>(null);

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
  // Same treatment: read inside the drag-start callback, and a status-date
  // change must not resubscribe the engine listeners mid-drag.
  const statusDateRef = useRef(statusDate ?? null);
  useEffect(() => { statusDateRef.current = statusDate ?? null; }, [statusDate]);
  // Same treatment for the resize preview's mask (#4237) — the mask arrives
  // with the project detail fetch, after the engine listeners are subscribed.
  const workingDaysMaskRef = useRef(workingDaysMask ?? MON_FRI_MASK);
  useEffect(() => {
    workingDaysMaskRef.current = workingDaysMask ?? MON_FRI_MASK;
  }, [workingDaysMask]);

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
        ariaLiveRef.current.textContent = milestoneDeltaAnnouncement(msg.worstMilestone);
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

    // drag-start: record dragged task, initialise state, and send the subgraph
    // to the worker ONCE (issue #1524). The dragged task's downstream subgraph
    // is topologically invariant for the whole drag — a drag moves a bar's date,
    // not the dependency network — so building it here (O(N+E) BFS) once, rather
    // than on every drag-task-move, keeps the per-frame cost to a tiny message.
    const offDragTask = engine.on('drag-task', (ev) => {
      startDrag(ev.id);
      seqRef.current = 0;
      activeGestureRef.current = 'drag';

      // #2819: the bar under the cursor may be pinned by recorded actuals, in
      // which case the server will re-pin it on the next CPM run and the drop
      // will change nothing. PreviewOverlay says so visually; the overlay is
      // aria-hidden (rule 27), so this is the only channel that reaches a
      // screen reader — and it has to fire at drag START, because by drag end
      // the user has already committed to a gesture that does nothing.
      const dragged = tasksRef.current.find((t) => t.id === ev.id);
      if (ariaLiveRef.current && dragged && isPinnedByActuals(dragged)) {
        ariaLiveRef.current.textContent = PINNED_DRAG_EXPLANATION;
      }

      const worker = workerRef.current;
      if (!worker) return;

      const subgraph = buildSubgraph(ev.id, tasksRef.current, linksRef.current);
      const startMsg: DragStartMessage = {
        type: 'DRAG_START',
        draggedTaskId: ev.id,
        subgraph,
        statusDate: statusDateRef.current,
      };
      worker.postMessage(startMsg);
    });

    // drag-move: send only the changed start (rule 56/57: use engine.scales +
    // leftToDate). The worker already holds the resident subgraph from DRAG_START,
    // so the per-frame payload is just {seq, newStartIso} — no subgraph rebuild
    // or re-clone across the worker boundary (issue #1524). Emits are already
    // deduped to snapped-date changes by the engine.
    const offDragMove = engine.on('drag-task-move', (ev) => {
      const worker = workerRef.current;
      if (!worker) return;

      const scaleData = engine.scales;
      if (!scaleData) return;

      // ev.left is canvas-origin (rule 57) — convert directly to date, through
      // the same reading the commit uses so an end-of-day milestone held in
      // place previews as unmoved rather than as the next day (#4079).
      const dragged = tasksRef.current.find((t) => t.id === ev.id);
      const newStartIso = dragged?.start
        ? dragDropStartIso(ev.left, dragged, scaleData)
        : leftToDate(ev.left, scaleData).toISOString().slice(0, 10);

      const seq = ++seqRef.current;
      const msg: DragMoveMessage = {
        type: 'DRAG_MOVE',
        seq,
        newStartIso,
      };
      worker.postMessage(msg);
    });

    // drag-end: commit or cancel, and release the worker's resident subgraph.
    const offDragEnd = engine.on('drag-task-end', (ev) => {
      const worker = workerRef.current;
      if (worker) {
        const endMsg: DragEndMessage = { type: 'DRAG_END' };
        worker.postMessage(endMsg);
      }

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

    // resize-start: record the resized task and send the subgraph to the
    // worker ONCE (issue #4237) — same rationale as drag-task: the dependency
    // network a duration change ripples through is topologically invariant
    // for the whole resize (a resize changes a bar's length, not the network).
    const offResizeTask = engine.on('resize-task', (ev) => {
      startDrag(ev.id);
      seqRef.current = 0;
      activeGestureRef.current = 'resize';

      // Same #2819 rationale as drag-task: a completed task with recorded
      // actuals is pinned, and the server will re-pin it on the next CPM run
      // regardless of what the handle previews.
      const resized = tasksRef.current.find((t) => t.id === ev.id);
      if (ariaLiveRef.current && resized && isPinnedByActuals(resized)) {
        ariaLiveRef.current.textContent = PINNED_DRAG_EXPLANATION;
      }

      const worker = workerRef.current;
      if (!worker) return;

      const subgraph = buildSubgraph(ev.id, tasksRef.current, linksRef.current);
      const startMsg: ResizeStartMessage = {
        type: 'RESIZE_START',
        resizedTaskId: ev.id,
        subgraph,
      };
      worker.postMessage(startMsg);
    });

    // resize-move: convert the dragged pixel to a working-day duration through
    // the SAME snap + no-op math `useScheduleCommit`'s resize-task-end commit
    // path uses (`resizeMoveFinishIso` / `workingDaysInclusive`, #4237), so the
    // live preview and the eventual PATCH never disagree about what a given
    // pixel means. `ev.right` is canvas-origin x of the bar's right edge (rule
    // 57), the resize counterpart of `drag-task-move`'s `ev.left`.
    const offResizeMove = engine.on('resize-task-move', (ev) => {
      const worker = workerRef.current;
      if (!worker) return;

      const scaleData = engine.scales;
      if (!scaleData) return;

      const resized = tasksRef.current.find((t) => t.id === ev.id);
      if (!resized?.start) return;

      const newFinish = resizeMoveFinishIso(ev.right, scaleData);
      // Mirrors the commit path's invalid-drop guard: a finish before the
      // task's own start is not a duration this gesture can preview.
      if (newFinish < resized.start) return;

      const newDurationDays = workingDaysInclusive(
        resized.start,
        newFinish,
        workingDaysMaskRef.current,
      );

      const seq = ++seqRef.current;
      const msg: ResizeMoveMessage = {
        type: 'RESIZE_MOVE',
        seq,
        newDurationDays,
      };
      worker.postMessage(msg);
    });

    // resize-end: commit or cancel, and release the worker's resident subgraph.
    const offResizeEnd = engine.on('resize-task-end', (ev) => {
      const worker = workerRef.current;
      if (worker) {
        const endMsg: ResizeEndMessage = { type: 'RESIZE_END' };
        worker.postMessage(endMsg);
      }

      if (ev.cancelled) {
        cancelDrag();
        if (ariaLiveRef.current) ariaLiveRef.current.textContent = 'Resize cancelled';
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
      // This listener is on `document`; guard bare-key bindings against firing
      // while the user types in a field. Escape is exempt — it must always be
      // able to cancel an in-flight drag or resize.
      if (isTypingInInput(e.target) && e.key !== 'Escape') return;
      if (e.key === 'Escape') {
        if (keyboardModeRef?.current) return;
        const phase = useDragStore.getState().phase;
        if (phase === 'dragging') {
          cancelDrag();
          engine.cancelDrag();
          if (ariaLiveRef.current) {
            ariaLiveRef.current.textContent =
              activeGestureRef.current === 'resize' ? 'Resize cancelled' : 'Drag cancelled';
          }
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      offDragTask();
      offDragMove();
      offDragEnd();
      offResizeTask();
      offResizeMove();
      offResizeEnd();
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [engine, startDrag, updatePreview, commitDrag, cancelDrag, setError, ariaLiveRef, keyboardModeRef]);
}
