/**
 * Cascade entries — rows that moved without this user touching them (#3041).
 *
 * The finding: `ReforecastPanel` ("What moved and why") sourced its rows from
 * `status === 'diverged'`, and an entry only reached `diverged` if it already
 * held an open client preview — i.e. if THIS user had just written it. So the
 * panel that exists to explain a downstream cascade could show every row except
 * the cascade.
 *
 * The load-bearing guard in this file is
 * `an observation without previous still marks nothing`. ADR-0784 §D6 declined
 * to admit these rows because "marking those would repaint the outline on every
 * teammate keystroke", and that risk is real for the FULL-SNAPSHOT path, which
 * observes every task on every load and every poll. If a bare observation could
 * open a cascade entry, the first render of a 400-row project would mark all 400.
 * `previous` is what separates the two paths; delete it and this file fails.
 */
import { describe, it, expect } from 'vitest';

import {
  CASCADE_MAX_ENTRIES,
  CASCADE_TTL_MS,
  acknowledgeAllDiverged,
  movedEntries,
  prune,
  reconcile,
  reconcileKey,
  registerPreview,
  reject,
  reviewableTaskIds,
  type ReconcileEntries,
} from './reconcileState';

const T0 = 1_700_000_000_000;
const KEY = reconcileKey('task-9', 'finish');

/** One delta-path observation: the caller knows the row moved. */
function moved(taskId: string, previous: string, value: string) {
  return { taskId, field: 'finish' as const, value, previous };
}

/** One snapshot-path observation: the caller knows only the current value. */
function seen(taskId: string, value: string) {
  return { taskId, field: 'finish' as const, value };
}

describe('cascade admission', () => {
  it('opens a cascade entry for a row this user never previewed', () => {
    const next = reconcile({}, [moved('task-9', '2026-10-13', '2026-10-16')], T0);
    expect(next[KEY]).toMatchObject({
      taskId: 'task-9',
      status: 'cascade',
      expected: '2026-10-13',
      actual: '2026-10-16',
    });
  });

  it('marks nothing when the observation carries no previous', () => {
    // The full-snapshot path. This is the §D6 guard: it sees EVERY task on every
    // load and poll, so if this ever starts creating entries, opening a project
    // marks the whole outline.
    const next = reconcile({}, [seen('task-9', '2026-10-16'), seen('task-8', '2026-11-02')], T0);
    expect(next).toEqual({});
  });

  it('marks nothing when the row was observed but did not move', () => {
    const next = reconcile({}, [moved('task-9', '2026-10-16', '2026-10-16')], T0);
    expect(next).toEqual({});
  });

  it('leaves a local preview on the diverged path, not the cascade path', () => {
    // A row the planner DID write must still read as "the server disagreed with
    // what you typed", even though the delta now carries `previous` for it too.
    const entries = registerPreview(
      {},
      { taskId: 'task-9', taskName: 'Spec freeze', field: 'finish', value: '2026-10-14' },
      T0,
    );
    const next = reconcile(entries, [moved('task-9', '2026-10-13', '2026-10-16')], T0 + 10);
    expect(next[KEY]).toMatchObject({
      status: 'diverged',
      // The value they TYPED, not the value that was on screen before the run.
      expected: '2026-10-14',
      actual: '2026-10-16',
    });
  });

  it('does not clear a rejection waiting on a human', () => {
    let entries = registerPreview(
      {},
      { taskId: 'task-9', taskName: 'Spec freeze', field: 'finish', value: '2026-10-14' },
      T0,
    );
    entries = reject(entries, 'task-9', 'finish', 'Locked by a baseline');
    const next = reconcile(entries, [moved('task-9', '2026-10-13', '2026-10-16')], T0 + 10);
    expect(next[KEY].status).toBe('rejected');
  });
});

describe('a cascade that moves again', () => {
  it('keeps the value the planner last saw as `expected`', () => {
    // §D1 applied to cascades: two runs read as ONE move away from what was on
    // screen, not a chain of machine states nobody watched.
    let entries = reconcile({}, [moved('task-9', '2026-10-13', '2026-10-16')], T0);
    entries = reconcile(entries, [moved('task-9', '2026-10-16', '2026-10-20')], T0 + 1000);
    expect(entries[KEY]).toMatchObject({ expected: '2026-10-13', actual: '2026-10-20' });
  });

  it('evicts the entry when the row returns to where it started', () => {
    let entries = reconcile({}, [moved('task-9', '2026-10-13', '2026-10-16')], T0);
    entries = reconcile(entries, [moved('task-9', '2026-10-16', '2026-10-13')], T0 + 1000);
    expect(entries[KEY]).toBeUndefined();
  });
});

describe('bounds — nothing local creates or clears a cascade', () => {
  it('evicts a cascade past its TTL', () => {
    const entries = reconcile({}, [moved('task-9', '2026-10-13', '2026-10-16')], T0);
    expect(prune(entries, T0 + CASCADE_TTL_MS - 1)[KEY]).toBeDefined();
    expect(prune(entries, T0 + CASCADE_TTL_MS)[KEY]).toBeUndefined();
  });

  it('caps stored cascades, dropping the oldest first', () => {
    let entries: ReconcileEntries = {};
    for (let i = 0; i < CASCADE_MAX_ENTRIES + 5; i++) {
      entries = reconcile(entries, [moved(`t${i}`, '2026-10-13', '2026-10-16')], T0 + i);
    }
    const pruned = prune(entries, T0 + CASCADE_MAX_ENTRIES + 5);
    expect(Object.keys(pruned)).toHaveLength(CASCADE_MAX_ENTRIES);
    // The five oldest went; the newest survived.
    expect(pruned[reconcileKey('t0', 'finish')]).toBeUndefined();
    expect(pruned[reconcileKey('t4', 'finish')]).toBeUndefined();
    expect(pruned[reconcileKey('t5', 'finish')]).toBeDefined();
  });

  it('never drops a rejection to make room under the cap', () => {
    // A rejection is a refusal the planner has not answered. Evicting one to fit
    // a cascade would lose the only record that their write was refused.
    let entries = registerPreview(
      {},
      { taskId: 'kept', taskName: 'Mine', field: 'finish', value: '2026-10-14' },
      T0,
    );
    entries = reject(entries, 'kept', 'finish', 'Locked');
    for (let i = 0; i < CASCADE_MAX_ENTRIES + 10; i++) {
      entries = reconcile(entries, [moved(`t${i}`, '2026-10-13', '2026-10-16')], T0 + 1 + i);
    }
    const pruned = prune(entries, T0 + CASCADE_MAX_ENTRIES + 20);
    expect(pruned[reconcileKey('kept', 'finish')].status).toBe('rejected');
  });

  it('is cleared by Dismiss along with the diverged rows', () => {
    const entries = reconcile({}, [moved('task-9', '2026-10-13', '2026-10-16')], T0);
    expect(acknowledgeAllDiverged(entries)).toEqual({});
  });
});

describe('derived reads', () => {
  it('counts cascades in the moved total the announcement uses', () => {
    let entries = registerPreview(
      {},
      { taskId: 'mine', taskName: 'Mine', field: 'finish', value: '2026-10-14' },
      T0,
    );
    entries = reconcile(entries, [{ ...moved('mine', '2026-10-13', '2026-10-16') }], T0 + 1);
    entries = reconcile(entries, [moved('theirs', '2026-11-01', '2026-11-04')], T0 + 2);
    // One the planner wrote, one they never touched. Announcing "1 date changed"
    // for a run that moved two states a number that is wrong.
    expect(movedEntries(entries)).toHaveLength(2);
  });

  it('narrows the review filter to cascade rows too', () => {
    const entries = reconcile({}, [moved('task-9', '2026-10-13', '2026-10-16')], T0);
    expect(reviewableTaskIds(entries)).toEqual(new Set(['task-9']));
  });
});
