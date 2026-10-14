import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEQ_REORDER_WINDOW_MS, SeqGate } from './wsSeqGate';

// ADR-1285 (#4386): the per-project seq is dense and commit-ordered, but two
// workers' sends can still arrive in the reverse of commit order.
describe('SeqGate', () => {
  let cursorRef: { current: number };
  let delivered: number[];
  let gate: SeqGate<number>;

  beforeEach(() => {
    vi.useFakeTimers();
    cursorRef = { current: 0 };
    delivered = [];
    gate = new SeqGate<number>({ cursorRef, deliver: (seq) => delivered.push(seq) });
  });

  afterEach(() => {
    gate.dispose();
    vi.useRealTimers();
  });

  it('applies the next contiguous frame immediately', () => {
    cursorRef.current = 9;
    gate.accept(10, 10);
    expect(delivered).toEqual([10]);
    expect(cursorRef.current).toBe(10);
  });

  it("applies the project's first-ever frame (seq 1) immediately on a fresh cursor", () => {
    gate.accept(1, 1);
    expect(delivered).toEqual([1]);
  });

  it('applies both frames of a reversed pair, in seq order, without waiting', () => {
    // The #4386 scenario: 10 and 11 committed in order, delivered 11-first. The
    // old high-water gate advanced to 11 and dropped 10 as a "duplicate".
    cursorRef.current = 9;
    gate.accept(11, 11);
    expect(delivered).toEqual([]); // held for its predecessor
    gate.accept(10, 10);
    expect(delivered).toEqual([10, 11]);
    expect(cursorRef.current).toBe(11);
    expect(gate.bufferedCount).toBe(0);
  });

  it('drops a genuine duplicate at or below the cursor', () => {
    cursorRef.current = 5;
    gate.accept(5, 5);
    gate.accept(3, 3);
    expect(delivered).toEqual([]);
    expect(cursorRef.current).toBe(5);
  });

  it('drops a second copy of a frame that is already held', () => {
    cursorRef.current = 1;
    gate.accept(3, 3);
    gate.accept(3, 3);
    gate.accept(2, 2);
    expect(delivered).toEqual([2, 3]);
  });

  it('never drops an early frame: on window expiry it applies and skips the hole', () => {
    cursorRef.current = 4;
    gate.accept(7, 7);
    gate.accept(6, 6);
    vi.advanceTimersByTime(SEQ_REORDER_WINDOW_MS - 1);
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(1);
    // 5 never arrived: 6 and 7 are applied in order and the cursor moves past it.
    expect(delivered).toEqual([6, 7]);
    expect(cursorRef.current).toBe(7);
  });

  it('orders a reversed pair at page load (unbaselined cursor) once the window expires', () => {
    gate.accept(58, 58);
    gate.accept(57, 57);
    vi.advanceTimersByTime(SEQ_REORDER_WINDOW_MS);
    expect(delivered).toEqual([57, 58]);
    expect(cursorRef.current).toBe(58);
  });

  it('flushes immediately once the buffer reaches its bound', () => {
    const small = new SeqGate<number>({
      cursorRef,
      deliver: (seq) => delivered.push(seq),
      maxBuffered: 3,
    });
    cursorRef.current = 1;
    small.accept(5, 5);
    small.accept(4, 4);
    expect(delivered).toEqual([]);
    small.accept(3, 3);
    expect(delivered).toEqual([3, 4, 5]);
    small.dispose();
  });

  it('discards held frames a resync re-baselined past', () => {
    cursorRef.current = 1;
    gate.accept(3, 3);
    gate.accept(9, 9);
    // resync_required baselines the shared cursor to the server head.
    cursorRef.current = 8;
    gate.accept(9, 9);
    gate.accept(10, 10);
    // 3 is stale; 9 was already held, and 9 then 10 apply once 9 is contiguous.
    vi.advanceTimersByTime(SEQ_REORDER_WINDOW_MS);
    expect(delivered).toEqual([9, 10]);
  });

  it('dispose drops held frames and the pending timer', () => {
    cursorRef.current = 1;
    gate.accept(3, 3);
    gate.dispose();
    vi.advanceTimersByTime(SEQ_REORDER_WINDOW_MS * 2);
    expect(delivered).toEqual([]);
    expect(cursorRef.current).toBe(1);
  });
});
