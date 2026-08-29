/**
 * Keyboard rescheduling for the Gantt chart (issue #34 — WCAG 2.1.1 gap).
 *
 * Closes the pointer-only drag interaction by allowing keyboard users to:
 *   - Press Shift+Enter (or 'r') on a selected task to enter keyboard
 *     reschedule mode. Plain Enter opens the task detail drawer instead (#2205).
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
import {
  isPinnedByActuals,
  PINNED_KEYBOARD_REFUSAL,
} from '@/features/schedule/pinnedByActuals';
import { nudgeWorkingDays } from '@/features/schedule/scheduleUtils';
import { createCpmWorker } from '@/workers/createCpmWorker';
import { isTypingInInput } from '@/hooks/useGlobalShortcut';

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
   * Persist the confirmed nudge (#3141).
   *
   * Required, not optional. This hook used to end its Enter handler at
   * `commitDrag()` — which only moves the drag store to `'committing'` — and
   * then announce "Reschedule confirmed." unconditionally. `useScheduleCommit`
   * listens for the engine's `drag-task-end`, which ONLY the pointer path
   * emits, so the keyboard path reached `'committing'` and stopped there: the
   * date never moved and the user was told it had. An optional prop would let a
   * future call site reintroduce exactly that silence.
   *
   * The callee owns the success announcement, since only it knows whether the
   * write landed.
   */
  onCommitReschedule: (taskId: string, newStartIso: string) => void;
  /**
   * Mutable ref set to `true` while keyboard mode is active. Read by
   * useDragCpm to prevent its Escape handler from double-cancelling.
   */
  keyboardModeRef: RefObject<boolean>;
  /**
   * The project's data date (`Project.status_date`), or null to resolve it to
   * today the way the server does (ADR-0132 §1, issue #2813). Floors the
   * previewed start of the task being moved, so a nudge into the past previews
   * the date the server will actually commit.
   */
  statusDate?: string | null;
  /**
   * True while the focused Timeline bar can be authored — build mode is on AND
   * this reader may edit the row (#2784).
   *
   * When it is, `Shift+Enter` belongs to **insert row above** and must NOT also
   * start a reschedule. This flag exists because the two handlers are on
   * different elements: `ScheduleAriaOverlay`'s React handler inserts the row,
   * and *this* listener is on `document` and fires after it in bubble order,
   * reading the selection rather than the event target. Without the gate a
   * single `Shift+Enter` would insert a row and start a reschedule on the
   * previously-selected task in the same press.
   *
   * `preventDefault` cannot express this: the overlay already calls it on the
   * working `Shift+Enter` path today and this listener still initiates, which is
   * the documented interplay `ScheduleAriaOverlay.keyboard.test.tsx` pins.
   *
   * Reschedule is not left without a key — `r` / `R` has been its single-key
   * alias since #2205 and is unaffected in either mode. ADR-0909 §4.
   */
  authoringActive?: boolean;
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
  statusDate,
  authoringActive = false,
  onOpenDatePopover,
  onCommitReschedule,
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
  // Same stable-ref treatment: read inside an engine event callback, and a
  // status-date change must not tear down and rebuild the key bindings.
  const statusDateRef = useRef(statusDate ?? null);
  useEffect(() => { statusDateRef.current = statusDate ?? null; }, [statusDate]);
  // Same treatment again: toggling build mode must not tear down and rebuild
  // the document listener, which would drop an in-flight reschedule.
  const authoringActiveRef = useRef(authoringActive);
  useEffect(() => { authoringActiveRef.current = authoringActive; }, [authoringActive]);

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
        statusDate: statusDateRef.current,
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

    /** Assertive screen-reader announcement (rule 53); no-op without the ref. */
    const announce = (text: string) => {
      if (ariaAssertiveRef.current) ariaAssertiveRef.current.textContent = text;
    };

    /** Reset keyboard-mode state after a confirm/cancel/offline exit. */
    const exitKeyboardMode = () => {
      keyboardModeRef.current = false;
      cumulativeDeltaRef.current = 0;
    };

    /**
     * Not-in-keyboard-mode entry: Shift+Enter or 'r' on a reschedulable selected
     * task starts keyboard mode. Plain Enter opens the task drawer elsewhere
     * (#2205), so it is deliberately ignored here.
     *
     * While authoring, `Shift+Enter` is **insert row above** (#2784) and drops
     * out of this set — see `authoringActive`. `r` / `R` is unconditional and
     * remains the reschedule key in both modes.
     */
    const tryInitiate = (e: KeyboardEvent) => {
      const shiftEnterInitiates = e.key === 'Enter' && e.shiftKey && !authoringActiveRef.current;
      const initiates = shiftEnterInitiates || e.key === 'r' || e.key === 'R';
      if (!initiates) return;
      const taskId = selectedTaskIdRef.current;
      if (!taskId) return;

      const task = tasksRef.current.find((t) => t.id === taskId);
      if (!task) return;

      // A summary task's dates roll up from its children, so there is nothing
      // here to move — the same reason the pointer path refuses it.
      if (task.isSummary) {
        e.preventDefault();
        announce(`${task.name} is a summary task — its dates roll up from its children.`);
        return;
      }

      // The refusal is keyed on recorded actuals, NOT on completion (#2827).
      //
      // Both server engines take a task out of network logic only when it is
      // complete AND carries an actual (`_pinned_placement` / `pinned_placement`,
      // ADR-0132), so a task complete by `progress` alone with no actuals is
      // still fully network-scheduled and its dates still move. The pointer path
      // reschedules exactly that task, so the old `isComplete` gate left the two
      // input paths disagreeing about one task — a WCAG 2.1.1 gap on the class
      // of task a keyboard user is most likely to be correcting.
      //
      // `isPinnedByActuals` is the shared client mirror of that server predicate
      // (#2819); keeping both paths on the one helper is what stops them
      // drifting apart again.
      //
      // Both refusals announce. Before this, the keypress was dropped in
      // silence, so a screen-reader user pressing 'r' on a complete task got
      // nothing — no movement and no reason.
      if (isPinnedByActuals(task)) {
        e.preventDefault();
        announce(`${task.name}: ${PINNED_KEYBOARD_REFUSAL}`);
        return;
      }

      keyboardModeRef.current = true;
      origStartRef.current = task.start;
      cumulativeDeltaRef.current = 0;
      seqRef.current = 0;
      startDrag(taskId, true); // isKeyboard = true
      e.preventDefault();
      announce(
        `Keyboard reschedule: ${task.name}. Arrow keys to nudge, Enter to confirm, Escape to cancel.`,
      );
    };

    /** Enter in keyboard mode: commit the pending nudge, guarding offline. */
    const confirmReschedule = () => {
      // Offline guard (mirrors rule 29 for pointer drag).
      if (!navigator.onLine) {
        cancelDrag();
        exitKeyboardMode();
        announce("You're offline — change not saved.");
        return;
      }
      const confirmedStart = nudgeWorkingDays(origStartRef.current, cumulativeDeltaRef.current);
      const taskId = selectedTaskIdRef.current;
      commitDrag(confirmedStart);
      exitKeyboardMode();
      // No announcement here. The write is async and its outcome is not knowable
      // at this point — announcing success unconditionally is the defect this
      // fixes (#3141). `onCommitReschedule` announces confirmation on success
      // and the reason on failure.
      if (taskId) onCommitReschedule(taskId, confirmedStart);
    };

    /** Escape in keyboard mode: discard the pending nudge. */
    const cancelReschedule = () => {
      cancelDrag();
      exitKeyboardMode();
      announce('Reschedule cancelled.');
    };

    /** In-keyboard-mode key routing (arrows nudge, d opens popover, Enter/Esc exit). */
    const handleActiveKey = (e: KeyboardEvent) => {
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

        case 'Enter':
          e.preventDefault();
          confirmReschedule();
          break;

        case 'Escape':
          e.preventDefault();
          cancelReschedule();
          break;
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // This listener is on `document`. Suppress every binding while the user
      // is typing in a field, except Escape (which must still cancel an active
      // reschedule). Without this guard, pressing Enter to submit a search box
      // would initiate a keyboard reschedule on the selected task.
      if (isTypingInInput(e.target) && e.key !== 'Escape') return;

      // Plain Enter now opens the task detail drawer (#2205); reschedule moved
      // to Shift+Enter / 'r' so both actions are reachable from a focused bar.
      if (!keyboardModeRef.current) {
        tryInitiate(e);
        return;
      }
      handleActiveKey(e);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    engine,
    keyboardModeRef,
    startDrag,
    commitDrag,
    onCommitReschedule,
    cancelDrag,
    setKeyboardDelta,
    ariaLiveRef,
    ariaAssertiveRef,
    onOpenDatePopover,
  ]);
}
