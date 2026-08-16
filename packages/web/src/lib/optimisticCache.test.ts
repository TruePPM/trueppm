import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { optimisticListAppend, optimisticListUpdate } from './optimisticCache';

interface Row {
  id: string;
}

function newQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const KEY = ['rows', 'p1'];

describe('optimisticListUpdate', () => {
  it('applies the updater to a populated list', () => {
    const qc = newQc();
    qc.setQueryData<Row[]>(KEY, [{ id: 'a' }, { id: 'b' }]);

    const previous = optimisticListUpdate<Row>(qc, KEY, (rows) =>
      rows.filter((r) => r.id !== 'a'),
    );

    expect(qc.getQueryData<Row[]>(KEY)).toEqual([{ id: 'b' }]);
    expect(previous).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('leaves an empty-but-present list writable', () => {
    const qc = newQc();
    qc.setQueryData<Row[]>(KEY, []);

    optimisticListUpdate<Row>(qc, KEY, (rows) => [...rows, { id: 'a' }]);

    expect(qc.getQueryData<Row[]>(KEY)).toEqual([{ id: 'a' }]);
  });

  it('no-ops entirely when the cache entry is absent (#2717, #2862)', () => {
    const qc = newQc();
    let updaterRan = false;

    const previous = optimisticListUpdate<Row>(qc, KEY, (rows) => {
      updaterRan = true;
      return [...rows, { id: 'a' }];
    });

    // The whole point: a missing entry means "not loaded", not "empty". It must
    // stay missing rather than being coerced to [] (or to a one-row list).
    expect(qc.getQueryData<Row[]>(KEY)).toBeUndefined();
    expect(updaterRan).toBe(false);
    expect(previous).toBeUndefined();
  });

  it('reads the cache at write time, so an invalidation mid-mutation cannot resurrect stale rows', () => {
    // The race #2862 describes: the snapshot read and the optimistic write are
    // not atomic, and a WS-driven invalidation can remove the entry between
    // them. Because the write is a functional updater, it sees the *current*
    // (now absent) cache and declines, rather than writing pre-race data back.
    const qc = newQc();
    qc.setQueryData<Row[]>(KEY, [{ id: 'a' }]);

    const original = qc.getQueryData.bind(qc);
    let readOnce = false;
    // Drop the entry immediately after the snapshot read — the exact window.
    qc.getQueryData = ((...args: Parameters<typeof original>) => {
      const value = original(...args);
      if (!readOnce) {
        readOnce = true;
        qc.removeQueries({ queryKey: KEY });
      }
      return value;
    }) as typeof qc.getQueryData;

    const previous = optimisticListUpdate<Row>(qc, KEY, (rows) => [...rows, { id: 'b' }]);

    expect(previous).toEqual([{ id: 'a' }]);
    expect(qc.getQueryData<Row[]>(KEY)).toBeUndefined();
  });
});

describe('optimisticListAppend', () => {
  it('appends to the end of a populated list and returns the snapshot', () => {
    const qc = newQc();
    qc.setQueryData<Row[]>(KEY, [{ id: 'a' }]);

    const previous = optimisticListAppend<Row>(qc, KEY, { id: 'b' });

    expect(qc.getQueryData<Row[]>(KEY)).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(previous).toEqual([{ id: 'a' }]);
  });

  it('does not manufacture a one-row list when the cache entry is absent (#2862)', () => {
    const qc = newQc();

    const previous = optimisticListAppend<Row>(qc, KEY, { id: 'b' });

    expect(qc.getQueryData<Row[]>(KEY)).toBeUndefined();
    expect(previous).toBeUndefined();
  });
});

/**
 * The generalizing guard (#2862).
 *
 * This bug class has now been fixed instance-by-instance four times: the board
 * updaters (#2717), then four sibling append hooks plus two more found by sweep
 * (#2862). Hand-enumerating the hooks is exactly what let the class survive, so
 * this guard enumerates by **scan**: every `setQueryData` call in the tree is
 * extracted by paren-matching and checked for a bare identifier defaulted to
 * `[]`/`{}` — `previous ?? []`, `(prev ?? []).filter`, `(rows ?? []).map`,
 * `updater(prev ?? [])`. That default is the bug: it turns "not loaded right
 * now" into "this collection is empty" and writes the lie into the cache.
 *
 * The sanctioned replacement is {@link optimisticListUpdate} /
 * {@link optimisticListAppend}, which skip the updater entirely on a nullish
 * entry. A member expression (`t.labels ?? []`) is deliberately *not* flagged —
 * defaulting a row's own nested field is unrelated to the cache-entry question.
 */
describe('no cache entry is defaulted to an empty collection', () => {
  const modules = import.meta.glob('../**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  /** Extract the source of each `setQueryData(...)` call by paren-matching. */
  function setQueryDataCalls(source: string): string[] {
    const spans: string[] = [];
    const marker = /setQueryData\s*(?:<[^(]*?>)?\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = marker.exec(source)) !== null) {
      let depth = 1;
      let i = match.index + match[0].length;
      while (i < source.length && depth > 0) {
        if (source[i] === '(') depth += 1;
        else if (source[i] === ')') depth -= 1;
        i += 1;
      }
      spans.push(source.slice(match.index, i));
    }
    return spans;
  }

  // A bare identifier — not `foo.bar` — defaulted to an empty array or object.
  const NULLISH_CACHE_DEFAULT = /(?<![.?\w$])[A-Za-z_$][\w$]*\s*(?:\?\?|\|\|)\s*(?:\[\s*\]|\{\s*\})/;

  it('every setQueryData writer no-ops on a nullish entry instead of defaulting it', () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(modules)) {
      // This guard and the helper both necessarily spell the banned pattern out.
      if (path.includes('optimisticCache')) continue;
      if (typeof source !== 'string') continue;
      for (const call of setQueryDataCalls(source)) {
        if (NULLISH_CACHE_DEFAULT.test(call)) offenders.push(path);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});
