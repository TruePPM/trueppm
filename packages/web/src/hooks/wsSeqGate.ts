/**
 * Ordering gate for sequenced WebSocket frames (ADR-1285, #4386).
 *
 * The server stamps every replayable board event with a **per-project, dense,
 * commit-ordered** `seq` (1, 2, 3, … with no holes). Dense allocation does not make
 * delivery ordered: two workers that commit 10 and then 11 can still have their
 * `group_send`s arrive 11-first. The gate therefore keeps a contiguous cursor and a
 * small reorder buffer:
 *
 * - `seq <= cursor` — already applied: a genuine duplicate (replay↔live overlap, a
 *   redelivered replay). Dropped.
 * - `seq === cursor + 1` — the next frame. Applied, then any buffered successors
 *   that are now contiguous are applied in order.
 * - `seq > cursor + 1` — a predecessor is missing or still in flight. Buffered for
 *   up to `windowMs`; if the predecessor arrives the run drains in order, so a
 *   reversed pair is applied in seq order rather than one of them being dropped.
 *   If the window expires (or the buffer fills) the buffered frames are applied in
 *   ascending order and the cursor jumps past the hole, so a frame is not dropped
 *   for being early. The window is the bound: a predecessor arriving later than
 *   `windowMs` meets `seq <= cursor` and is dropped, and `?since=` cannot replay
 *   it, because the cursor is already past the hole (gap → resync is #2848).
 *
 * A cursor of 0 means "not yet baselined" (a fresh mount that has never seen a
 * frame and holds no `since`). Unless that first frame is seq 1 — the project's
 * first event ever — it waits out the window too, so a reversed pair at page load
 * is still applied in order; the expiry is not a gap in that case, because nothing
 * below the first frame was ever owed to this client.
 *
 * The cursor lives in the caller's ref, not here, because two other paths own it
 * too: the reconnect dials `?since=<cursor>`, and `resync_required` re-baselines
 * it to the server's head.
 */
import type { MutableRefObject } from 'react';

/** How long a frame that arrived ahead of its predecessor waits for it. */
export const SEQ_REORDER_WINDOW_MS = 750;

/** Buffered frames past which the gate stops waiting and flushes. */
export const SEQ_REORDER_MAX_BUFFERED = 256;

export interface SeqGateOptions<T> {
  /** The contiguous cursor: the highest seq applied with nothing missing below it. */
  cursorRef: MutableRefObject<number>;
  /** Applies one frame. Called in ascending seq order. */
  deliver: (frame: T) => void;
  windowMs?: number;
  maxBuffered?: number;
}

export class SeqGate<T> {
  private readonly buffer = new Map<number, T>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly windowMs: number;
  private readonly maxBuffered: number;

  constructor(private readonly opts: SeqGateOptions<T>) {
    this.windowMs = opts.windowMs ?? SEQ_REORDER_WINDOW_MS;
    this.maxBuffered = opts.maxBuffered ?? SEQ_REORDER_MAX_BUFFERED;
  }

  /** Offer one sequenced frame to the gate. */
  accept(seq: number, frame: T): void {
    const cursor = this.opts.cursorRef.current;
    if (seq <= cursor || this.buffer.has(seq)) return;
    if (seq === cursor + 1) {
      this.apply(seq, frame);
      this.drain();
      return;
    }
    this.buffer.set(seq, frame);
    if (this.buffer.size >= this.maxBuffered) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.windowMs);
  }

  /**
   * Drop held frames and the pending timer **without** advancing the cursor.
   *
   * Call it whenever the socket goes away. A held frame means its predecessor is
   * still owed. If the window were left to expire, the flush would apply the held
   * frame and move the cursor past the hole while no socket is open. The reconnect
   * would then send `?since=` above the hole and the predecessor would be lost.
   * Dropped here, the cursor stays contiguous, and the reconnect's replay serves
   * the predecessor and the held frame again, in order.
   */
  dropHeld(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.buffer.clear();
  }

  /** Socket teardown for good (unmount or project switch): same as `dropHeld`. */
  dispose(): void {
    this.dropHeld();
  }

  /** Frames currently waiting for a predecessor (for tests and diagnostics). */
  get bufferedCount(): number {
    return this.buffer.size;
  }

  private apply(seq: number, frame: T): void {
    this.opts.cursorRef.current = seq;
    this.opts.deliver(frame);
  }

  // Apply every buffered frame that is now contiguous with the cursor. Entries at
  // or below the cursor are stale — a resync_required re-baselined it past them —
  // and are discarded.
  private drain(): void {
    for (const seq of [...this.buffer.keys()]) {
      if (seq <= this.opts.cursorRef.current) this.buffer.delete(seq);
    }
    let next = this.opts.cursorRef.current + 1;
    while (this.buffer.has(next)) {
      const frame = this.buffer.get(next) as T;
      this.buffer.delete(next);
      this.apply(next, frame);
      next += 1;
    }
    if (this.buffer.size === 0 && this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // The window expired or the buffer filled: apply what we have in order and move
  // the cursor past any hole. When the cursor was baselined, a hole here is a frame
  // the channel layer genuinely lost.
  // TODO(#2848): signal that confirmed gap (cursor > 0 and a hole was skipped) so
  // the hook can run the project-scoped resync invalidation.
  private flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const pending = [...this.buffer.entries()].sort((a, b) => a[0] - b[0]);
    this.buffer.clear();
    for (const [seq, frame] of pending) {
      if (seq > this.opts.cursorRef.current) this.apply(seq, frame);
    }
  }
}
