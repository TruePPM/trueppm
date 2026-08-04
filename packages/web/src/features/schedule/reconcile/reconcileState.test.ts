/**
 * The #2725 acceptance test: the marker state machine
 * (preview → acked → diverged → acknowledged), plus the eviction rules and the
 * two decisions in ADR-0784 §D1/§D6 that are easy to regress silently.
 */
import { describe, it, expect } from 'vitest';

import {
  PREVIEW_TTL_MS,
  acknowledge,
  acknowledgeAllDiverged,
  divergedEntries,
  prune,
  reconcile,
  reconcileKey,
  registerPreview,
  reject,
  rejectedEntries,
  reviewableTaskIds,
  type ReconcileEntries,
} from './reconcileState';

const T0 = 1_700_000_000_000;
const KEY = reconcileKey('task-1', 'finish');

function withPreview(value = '2026-10-13', nowMs = T0): ReconcileEntries {
  return registerPreview(
    {},
    { taskId: 'task-1', taskName: 'Spec freeze', field: 'finish', value },
    nowMs,
  );
}

describe('reconcileState — the marker lifecycle', () => {
  it('registerPreview opens a preview entry holding the authored value', () => {
    const entries = withPreview();
    expect(entries[KEY]).toMatchObject({
      taskId: 'task-1',
      field: 'finish',
      status: 'preview',
      expected: '2026-10-13',
      actual: null,
      since: T0,
    });
  });

  it('preview → acked: a server value equal to the preview EVICTS the entry', () => {
    const entries = reconcile(
      withPreview(),
      [{ taskId: 'task-1', field: 'finish', value: '2026-10-13' }],
      T0 + 1000,
    );
    expect(entries[KEY]).toBeUndefined();
    expect(divergedEntries(entries)).toHaveLength(0);
  });

  it('preview → diverged: a different server value records from → to', () => {
    const entries = reconcile(
      withPreview(),
      [{ taskId: 'task-1', field: 'finish', value: '2026-10-16' }],
      T0 + 1000,
    );
    expect(entries[KEY]).toMatchObject({
      status: 'diverged',
      expected: '2026-10-13',
      actual: '2026-10-16',
    });
  });

  it('diverged → acknowledged: acknowledge evicts the entry', () => {
    let entries = reconcile(
      withPreview(),
      [{ taskId: 'task-1', field: 'finish', value: '2026-10-16' }],
      T0 + 1000,
    );
    entries = acknowledge(entries, 'task-1', 'finish');
    expect(entries[KEY]).toBeUndefined();
  });
});

describe('reconcileState — the two rules that regress silently', () => {
  it('a SECOND divergence keeps the originally authored `from`', () => {
    // ADR-0784 §D1: `from` is what the PLANNER believed, not the previous CPM
    // pass. Two cascading runs must read as one move away from what they typed.
    let entries = reconcile(
      withPreview(),
      [{ taskId: 'task-1', field: 'finish', value: '2026-10-16' }],
      T0 + 1000,
    );
    entries = reconcile(
      entries,
      [{ taskId: 'task-1', field: 'finish', value: '2026-10-19' }],
      T0 + 2000,
    );
    expect(entries[KEY]).toMatchObject({
      expected: '2026-10-13', // NOT 2026-10-16
      actual: '2026-10-19',
    });
  });

  it('a new preview SUPERSEDES a diverged entry', () => {
    // The planner just re-authored that value; they are no longer being asked to
    // spot a difference they themselves overwrote.
    let entries = reconcile(
      withPreview(),
      [{ taskId: 'task-1', field: 'finish', value: '2026-10-16' }],
      T0 + 1000,
    );
    entries = registerPreview(
      entries,
      { taskId: 'task-1', taskName: 'Spec freeze', field: 'finish', value: '2026-11-02' },
      T0 + 3000,
    );
    expect(entries[KEY]).toMatchObject({
      status: 'preview',
      expected: '2026-11-02',
      actual: null,
    });
  });

  it('an observation for a task with NO open entry is ignored', () => {
    // §D6: divergence is defined against a local preview. A task moving with no
    // entry is a collaborator's edit or a cascade onto untouched work — marking
    // it would repaint the outline on every teammate keystroke.
    const entries = reconcile(
      {},
      [{ taskId: 'someone-elses-task', field: 'finish', value: '2026-10-16' }],
      T0,
    );
    expect(Object.keys(entries)).toHaveLength(0);
  });

  it('an unrelated CPM pass does NOT clear a rejected entry', () => {
    let entries = reject(withPreview(), 'task-1', 'finish', 'You do not have permission.');
    entries = reconcile(
      entries,
      [{ taskId: 'task-1', field: 'finish', value: '2026-10-13' }],
      T0 + 1000,
    );
    expect(entries[KEY]).toMatchObject({ status: 'rejected' });
  });

  it('reconcile is idempotent — replaying the same delta is a no-op', () => {
    const obs = [{ taskId: 'task-1', field: 'finish' as const, value: '2026-10-16' }];
    const once = reconcile(withPreview(), obs, T0 + 1000);
    const twice = reconcile(once, obs, T0 + 2000);
    expect(twice).toBe(once); // same reference — nothing was rewritten
  });

  it('a null observed value leaves the entry alone', () => {
    const entries = reconcile(
      withPreview(),
      [{ taskId: 'task-1', field: 'finish', value: null }],
      T0 + 1000,
    );
    expect(entries[KEY]).toMatchObject({ status: 'preview' });
  });
});

describe('reconcileState — rejection', () => {
  it('reject carries the server reason and survives acknowledgeAll', () => {
    let entries = reject(withPreview(), 'task-1', 'finish', 'Task is locked by a baseline.');
    expect(rejectedEntries(entries)[0]).toMatchObject({
      status: 'rejected',
      reason: 'Task is locked by a baseline.',
    });
    // acknowledgeAll clears DIVERGED only — a rejection still needs a human.
    entries = acknowledgeAllDiverged(entries);
    expect(rejectedEntries(entries)).toHaveLength(1);
  });

  it('reject on a task with no entry is a no-op', () => {
    expect(reject({}, 'ghost', 'start', 'nope')).toEqual({});
  });
});

describe('reconcileState — eviction', () => {
  it('prune evicts a preview past the TTL, leaving NO marker', () => {
    const entries = prune(withPreview(), T0 + PREVIEW_TTL_MS);
    expect(entries[KEY]).toBeUndefined();
    // Crucially it did NOT become diverged — we cannot evidence a divergence.
    expect(divergedEntries(entries)).toHaveLength(0);
  });

  it('prune leaves a diverged entry alone regardless of age', () => {
    const diverged = reconcile(
      withPreview(),
      [{ taskId: 'task-1', field: 'finish', value: '2026-10-16' }],
      T0,
    );
    expect(prune(diverged, T0 + PREVIEW_TTL_MS * 10)[KEY]).toBeDefined();
  });

  it('prune evicts entries for tasks absent from a full snapshot', () => {
    const entries = prune(withPreview(), T0, new Set(['other-task']));
    expect(entries[KEY]).toBeUndefined();
  });

  it('prune WITHOUT a task-id set does not evict on absence', () => {
    // The WebSocket delta path observes a subset of tasks; pruning against that
    // subset would evict every untouched row's entry.
    expect(prune(withPreview(), T0)[KEY]).toBeDefined();
  });

  it('acknowledgeAllDiverged returns the same reference when nothing changed', () => {
    const entries = withPreview();
    expect(acknowledgeAllDiverged(entries)).toBe(entries);
  });
});

describe('reconcileState — derived reads', () => {
  it('reviewableTaskIds covers diverged and rejected, not preview', () => {
    let entries = registerPreview(
      {},
      { taskId: 'pending', taskName: 'A', field: 'start', value: '2026-01-01' },
      T0,
    );
    entries = registerPreview(
      entries,
      { taskId: 'moved', taskName: 'B', field: 'finish', value: '2026-02-01' },
      T0,
    );
    entries = registerPreview(
      entries,
      { taskId: 'refused', taskName: 'C', field: 'start', value: '2026-03-01' },
      T0,
    );
    entries = reconcile(entries, [{ taskId: 'moved', field: 'finish', value: '2026-02-05' }], T0);
    entries = reject(entries, 'refused', 'start', 'Read-only.');

    expect(reviewableTaskIds(entries)).toEqual(new Set(['moved', 'refused']));
  });
});
