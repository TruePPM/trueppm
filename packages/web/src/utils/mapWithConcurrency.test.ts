import { describe, it, expect, vi } from 'vitest';
import { mapWithConcurrency } from './mapWithConcurrency';

/** A promise plus the resolve/reject handles to settle it from the test body. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('mapWithConcurrency', () => {
  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapWithConcurrency(
      Array.from({ length: 25 }, (_, i) => i),
      4,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Yield twice so every worker has a chance to start before any finishes —
        // a single await would let each call complete before the next begins and
        // the peak would read 1 no matter what the limit was.
        await Promise.resolve();
        await Promise.resolve();
        inFlight--;
        return n * 2;
      },
    );

    expect(peak).toBe(4);
    expect(result).toHaveLength(25);
  });

  it('resolves in input order regardless of completion order', async () => {
    // Item 0 settles last; a naive "push as they land" would put it at the end.
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const promise = mapWithConcurrency(['a', 'b', 'c'], 3, (_item, i) => gates[i].promise);

    gates[2].resolve('third');
    gates[1].resolve('second');
    gates[0].resolve('first');

    await expect(promise).resolves.toEqual(['first', 'second', 'third']);
  });

  it('runs everything when the limit exceeds the item count', async () => {
    const fn = vi.fn((n: number) => Promise.resolve(n + 1));
    await expect(mapWithConcurrency([1, 2], 10, fn)).resolves.toEqual([2, 3]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('is a no-op on an empty input', async () => {
    const fn = vi.fn();
    await expect(mapWithConcurrency([], 4, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects with the first error and starts no further work', async () => {
    const started: number[] = [];
    const promise = mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      2,
      async (n) => {
        started.push(n);
        await Promise.resolve();
        if (n === 1) throw new Error('page 1 failed');
        return n;
      },
    );

    await expect(promise).rejects.toThrow('page 1 failed');
    // The two workers claim 0 and 1; the surviving worker may claim one more
    // before it observes the failure, but the remaining 17 are never requested.
    expect(started.length).toBeLessThanOrEqual(4);
    expect(started).not.toContain(19);
  });

  it('rejects a limit below 1 rather than hanging', async () => {
    await expect(mapWithConcurrency([1], 0, (n) => Promise.resolve(n))).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], 1.5, (n) => Promise.resolve(n))).rejects.toThrow(
      RangeError,
    );
  });
});
