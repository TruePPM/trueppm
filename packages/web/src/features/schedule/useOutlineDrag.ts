/**
 * The pointer half of the outline's drag-to-rearrange (#2954).
 *
 * Pointer Events, not HTML5 drag-and-drop, and that is a requirement rather than
 * a preference: `dragstart` never fires from a finger, so an HTML5 implementation
 * would ship a desktop-only gesture on a product whose second surface is a phone.
 * The same handlers here drive mouse, pen and touch.
 *
 * The session lives here, in the list, rather than on the row that started it —
 * the row cannot answer "what is under the pointer now", and a row that
 * virtualizes away mid-drag would take the session with it.
 *
 * Two guards worth naming:
 *
 *  - **A drag does not start on `pointerdown`.** It starts once the pointer has
 *    travelled past a threshold, so a click on the grip is still a click and a
 *    scroll gesture that begins on it is still a scroll.
 *  - **Escape cancels**, and cancelling is silent — nothing was written yet, so
 *    there is nothing to undo and nothing to announce beyond "cancelled".
 */

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  describeDropIntent,
  planOutlineMove,
  resolveDropIntent,
  type DropIntent,
  type OutlineDragRow,
  type OutlineMovePlan,
} from './outlineDrag';

/** Travel, in px, before a press becomes a drag. Matches dnd-kit's PointerSensor default. */
export const DRAG_ACTIVATION_PX = 4;

/**
 * Press-and-hold, in ms, that lifts a row on a coarse pointer.
 *
 * A finger that moves 4px is usually scrolling, so the distance threshold alone
 * would make the outline either undraggable or unscrollable. Holding still is
 * the one signal that means "I intend to move this row, not the list".
 */
export const LONG_PRESS_MS = 350;

export interface OutlineDragSession {
  draggedId: string;
  intent: DropIntent;
  /** True once the gesture has passed activation — before that nothing is drawn. */
  active: boolean;
}

export interface UseOutlineDragArgs {
  rows: OutlineDragRow[];
  rowHeight: number;
  /** Top of the first row, in client coordinates. Re-read on every move — the list scrolls. */
  getRowsTop: () => number | null;
  /** Commits the move. Absent (a reader, or no query client) disables the whole gesture. */
  onMove?: (plan: OutlineMovePlan) => void;
  /** Polite live-region sink — the drop's consequence, spoken as it changes. */
  announce?: (sentence: string) => void;
  /** `pointer: coarse` override, for tests. Defaults to a media query. */
  coarse?: boolean;
}

export interface UseOutlineDragReturn {
  session: OutlineDragSession | null;
  /** Wire to the row grip's `onPointerDown`. */
  startDrag: (taskId: string, e: React.PointerEvent) => void;
}

function prefersCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

export function useOutlineDrag({
  rows,
  rowHeight,
  getRowsTop,
  onMove,
  announce,
  coarse,
}: UseOutlineDragArgs): UseOutlineDragReturn {
  const [session, setSession] = useState<OutlineDragSession | null>(null);

  // The moving parts of a gesture are read inside window listeners that must not
  // be torn down and rebuilt on every pointermove — a ref, not state.
  const gesture = useRef<{
    taskId: string;
    startX: number;
    startY: number;
    active: boolean;
    longPressTimer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const lastSentence = useRef<string | null>(null);

  // Latest values for the window listeners, which are attached once per drag.
  const latest = useRef({ rows, rowHeight, getRowsTop, onMove, announce, coarse });
  latest.current = { rows, rowHeight, getRowsTop, onMove, announce, coarse };

  const endGesture = useCallback(() => {
    const timer = gesture.current?.longPressTimer;
    if (timer) clearTimeout(timer);
    gesture.current = null;
    lastSentence.current = null;
    setSession(null);
  }, []);

  const startDrag = useCallback(
    (taskId: string, e: React.PointerEvent) => {
      if (!latest.current.onMove) return;
      // Left button / primary contact only — a right-click on the grip should
      // still reach the row's context menu.
      if (e.button !== 0) return;
      e.stopPropagation();

      const isCoarse = latest.current.coarse ?? prefersCoarsePointer();
      const g = {
        taskId,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
        longPressTimer: null as ReturnType<typeof setTimeout> | null,
      };
      gesture.current = g;
      setSession({ draggedId: taskId, intent: { kind: 'none' }, active: false });

      // Coarse pointer: a press that stays put lifts the row, so a swipe that
      // starts on the grip still scrolls the list.
      if (isCoarse) {
        g.longPressTimer = setTimeout(() => {
          if (gesture.current !== g) return;
          g.active = true;
          setSession({ draggedId: taskId, intent: { kind: 'none' }, active: true });
        }, LONG_PRESS_MS);
      }
    },
    [],
  );

  // Keyed on "is a gesture live", NOT on `session` — the session object changes
  // on every pointermove, and re-attaching window listeners at that rate drops
  // events on a loaded machine. Everything the listeners need that moves is read
  // off `gesture.current` / `latest.current` instead.
  const dragging = session !== null;
  useEffect(() => {
    if (!dragging) return;

    const resolve = (clientY: number, draggedId: string): DropIntent => {
      const { rows: r, rowHeight: h, getRowsTop: top, coarse: c } = latest.current;
      const rowsTop = top();
      if (rowsTop == null) return { kind: 'none' };
      return resolveDropIntent({
        rows: r,
        draggedId,
        localY: clientY - rowsTop,
        rowHeight: h,
        coarse: c ?? prefersCoarsePointer(),
      });
    };

    const onPointerMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      if (!g.active) {
        const travelled =
          Math.abs(e.clientX - g.startX) + Math.abs(e.clientY - g.startY) >= DRAG_ACTIVATION_PX;
        if (!travelled) return;
        // On a coarse pointer the long press is the only way in: travel before
        // it fires is a scroll, and claiming it as a drag is what makes an
        // outline unscrollable on a phone.
        if ((latest.current.coarse ?? prefersCoarsePointer()) && g.longPressTimer) {
          clearTimeout(g.longPressTimer);
          g.longPressTimer = null;
          gesture.current = null;
          setSession(null);
          return;
        }
        g.active = true;
      }
      // The row is lifted; the browser must not also select text or pan.
      e.preventDefault();
      const intent = resolve(e.clientY, g.taskId);
      setSession((prev) => (prev ? { ...prev, intent, active: true } : prev));

      const description = describeDropIntent(intent, latest.current.rows, g.taskId);
      const sentence = description?.sentence ?? null;
      if (sentence && sentence !== lastSentence.current) {
        lastSentence.current = sentence;
        latest.current.announce?.(sentence);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      const wasActive = g.active;
      const taskId = g.taskId;
      endGesture();
      if (!wasActive) return;
      const intent = resolve(e.clientY, taskId);
      const plan = planOutlineMove(intent, latest.current.rows, taskId);
      if (!plan) return;
      latest.current.onMove?.(plan);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !gesture.current) return;
      e.preventDefault();
      endGesture();
      latest.current.announce?.('Move cancelled.');
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', endGesture);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', endGesture);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [dragging, endGesture]);

  // A gesture left running when the list unmounts would keep window listeners alive.
  useEffect(() => endGesture, [endGesture]);

  return { session, startDrag };
}
