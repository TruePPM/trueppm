/**
 * Keyboard rescheduling for the Gantt chart (issue #34 — WCAG 2.1.1 gap).
 *
 * Closes the pointer-only drag interaction by allowing keyboard users to:
 *   - Press Enter on a selected task to enter keyboard reschedule mode.
 *   - ArrowRight / ArrowLeft to nudge by 1 working day.
 *   - Shift+Arrow to nudge by 5 working days.
 *   - 'd' to open the date input popover for precise entry.
 *   - Enter to confirm (triggers PATCH via drag store).
 *   - Escape to cancel.
 *
 * Reuses the same Zustand drag store and CPM Web Worker as useDragCpm so the
 * PreviewOverlay renders identical feedback for both pointer and keyboard modes.
 *
 * Design rules enforced:
 * - Rule 51: "← → Shift+arrow · Enter confirm · Esc cancel" instruction strip
 *   (rendered by PreviewOverlay when isKeyboardMode is true).
 * - Rule 52: Origin ghost bar shown at the task's pre-nudge position.
 * - Rule 53: aria-keyshortcuts on the Gantt root; assertive aria-live region
 *   announces each nudge to screen readers without re-rendering components.
 * - Rule 55: engine.on() always paired with unsubscribe in useEffect cleanup.
 */

import { useEffect, useRef, type RefObject } from 'react';
import type { GanttEngine } from '@/features/schedule/engine';
import type { Task, TaskLink } from '@/types';
import type { RecalcMessage, ResultMessage } from '@/workers/cpmWorker.types';
import { useDragStore } from '@/stores/dragStore';
import { buildSubgraph } from '@/features/schedule/buildSubgraph';
import { nudgeWorkingDays } from '@/features/schedule/scheduleUtils';
import { createCpmWorker } from '@/workers/createCpmWorker';

export interface UseKeyboardRescheduleOptions {
  engine: GanttEngine | null;
  tasks: Task[];
  links: TaskLink[];
  /** Polite aria-live ref — shared with useDragCpm for milestone slip messages. */
  ariaLiveRef: RefObject<HTMLDivElement | null>;
  /**
   * Assertive aria-live ref — used for nudge confirmations that must interrupt
   * the screen reader immediately (rule 53). Separate from ariaLiveRef to avoid
   * the polite queue delay on time-sensitive feedback.
   */
  ariaAssertiveRef: RefObject<HTMLDivElement | null>;
  /**
   * Mutable ref set to `true` while keyboard mode is active. Read by
   * useDragCpm to prevent its Escape handler from double-cancelling.
   */
  keyboardModeRef: RefObject<boolean>;
  /** Called when the user presses 'd' to open the date input popover. */
  onOpenDatePopover: (taskId: string) => void;
}

export function useKeyboardReschedule({
  engine,
  tasks,
  links,
  ariaLiveRef,
  ariaAssertiveRef,
  keyboardModeRef,
  onOpenDatePopover,
}: UseKeyboardRescheduleOptions): void {
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0);

  // Per-drag state kept in refs to avoid stale closure issues
  const selectedTaskIdRef = useRef<string | null>(null);
  const origStartRef = useRef<string>('');
  const cumulativeDeltaRef = useRef(0);

  // Stable refs for tasks/links (same pattern as useDragCpm)
  const tasksRef = useRef(tasks);
  const linksRef = useRef(links);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  useEffect(() => { linksRef.current = links; }, [links]);

  const startDrag = useDragStore((s) => s.startDrag);
  const updatePreview = useDragStore((s) => s.updatePreview);
  const commitDrag = useDragStore((s) => s.commitDrag);
  const cancelDrag = useDragStore((s) => s.cancelDrag);
  const setKeyboardDelta = useDragStore((s) => s.setKeyboardDelta);

  // Spawn / terminate a dedicated CPM worker for keyboard mode.
  // Separate from useDragCpm's worker — they are mutually exclusive.
  useEffect(() => {
    if (!engine) return;
    const worker = createCpmWorker();
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<ResultMessage>) => {
      const msg = event.data;
      if (msg.type !== 'RESULT') return;
      if (msg.seq < seqRef.current) return;

      updatePreview(msg.results, msg.worstMilestone, msg.overflowCount);

      // Polite announcement of the worst milestone slip (rule 30 pattern)
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

  // Track the selected task via engine.on('selection-change') (rule 55: always unsubscribe)
  useEffect(() => {
    if (!engine) return;
    const off = engine.on('selection-change', (ev) => {
      selectedTaskIdRef.current = ev.taskIds[0] ?? null;
    });
    return off;
  }, [engine]);

  // Main keyboard handler
  useEffect(() => {
    if (!engine) return;

    /** Send a RECALC message to the worker for the given cumulative delta. */
    const sendNudge = (newDelta: number) => {
      const worker = workerRef.current;
      const taskId = useDragStore.getState().draggedTaskId;
      if (!worker || !taskId) return;

      cumulativeDeltaRef.current = newDelta;
      const newStart = nudgeWorkingDays(origStartRef.current, newDelta);
      const subgraph = buildSubgraph(taskId, tasksRef.current, linksRef.current);
      const seq = ++seqRef.current;

      const msg: RecalcMessage = {
        type: 'RECALC',
        seq,
        draggedTaskId: taskId,
        newStartIso: newStart,
        subgraph,
      };
      worker.postMessage(msg);
      setKeyboardDelta(newDelta);

      // Assertive announcement of the nudge direction + magnitude (rule 53)
      if (ariaAssertiveRef.current) {
        const absDelta = Math.abs(newDelta);
        const direction = newDelta > 0 ? 'later' : newDelta < 0 ? 'earlier' : 'original';
        if (newDelta === 0) {
          ariaAssertiveRef.current.textContent = 'Back to original start date';
        } else {
          ariaAssertiveRef.current.textContent =
            `${absDelta} working day${absDelta === 1 ? '' : 's'} ${direction}`;
        }
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // ── Not in keyboard mode: only Enter can initiate ──────────────────────
      if (!keyboardModeRef.current) {
        if (e.key !== 'Enter') return;
        const taskId = selectedTaskIdRef.current;
        if (!taskId) return;

        const task = tasksRef.current.find((t) => t.id === taskId);
        // Summary tasks and completed tasks cannot be rescheduled via keyboard
        if (!task || task.isSummary || task.isComplete) return;

        keyboardModeRef.current = true;
        origStartRef.current = task.start;
        cumulativeDeltaRef.current = 0;
        seqRef.current = 0;
        startDrag(taskId, true); // isKeyboard = true
        e.preventDefault();

        if (ariaAssertiveRef.current) {
          ariaAssertiveRef.current.textContent =
            `Keyboard reschedule: ${task.name}. Arrow keys to nudge, Enter to confirm, Escape to cancel.`;
        }
        return;
      }

      // ── In keyboard mode ────────────────────────────────────────────────────
      const currentDelta = cumulativeDeltaRef.current;

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          sendNudge(currentDelta + (e.shiftKey ? 5 : 1));
          break;

        case 'ArrowLeft':
          e.preventDefault();
          sendNudge(currentDelta - (e.shiftKey ? 5 : 1));
          break;

        case 'd':
        case 'D': {
          e.preventDefault();
          const taskId = useDragStore.getState().draggedTaskId;
          if (taskId) onOpenDatePopover(taskId);
          break;
        }

        case 'Enter': {
          e.preventDefault();

          // Offline guard (mirrors rule 29 for pointer drag)
          if (!navigator.onLine) {
            cancelDrag();
            keyboardModeRef.current = false;
            cumulativeDeltaRef.current = 0;
            if (ariaAssertiveRef.current) {
              ariaAssertiveRef.current.textContent =
                "You're offline — change not saved.";
            }
            break;
          }

          const confirmedStart = nudgeWorkingDays(
            origStartRef.current,
            cumulativeDeltaRef.current,
          );
          commitDrag(confirmedStart);
          keyboardModeRef.current = false;
          cumulativeDeltaRef.current = 0;
          if (ariaAssertiveRef.current) {
            ariaAssertiveRef.current.textContent = 'Reschedule confirmed.';
          }
          break;
        }

        case 'Escape':
          e.preventDefault();
          cancelDrag();
          keyboardModeRef.current = false;
          cumulativeDeltaRef.current = 0;
          if (ariaAssertiveRef.current) {
            ariaAssertiveRef.current.textContent = 'Reschedule cancelled.';
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    engine,
    keyboardModeRef,
    startDrag,
    commitDrag,
    cancelDrag,
    setKeyboardDelta,
    ariaLiveRef,
    ariaAssertiveRef,
    onOpenDatePopover,
  ]);
}
