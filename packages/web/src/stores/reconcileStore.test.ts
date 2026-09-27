import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useReconcileStore } from './reconcileStore';
import { MON_FRI_MASK } from '@/features/schedule/reconcile/reconcileCopy';
import { reconcileKey } from '@/features/schedule/reconcile/reconcileState';

const INITIAL = useReconcileStore.getState();

function preview(taskId = 't1', field: 'start' | 'finish' = 'start') {
  useReconcileStore
    .getState()
    .registerPreview({ taskId, taskName: 'Pour', field, value: '2026-05-04' });
}

beforeEach(() => {
  useReconcileStore.setState(INITIAL, true);
});

describe('reconcileStore', () => {
  it('starts empty, on no project, with the Mon–Fri mask', () => {
    const s = useReconcileStore.getState();
    expect(s.projectId).toBeNull();
    expect(s.entries).toEqual({});
    expect(s.reviewFilterActive).toBe(false);
    expect(s.workingDaysMask).toBe(MON_FRI_MASK);
  });

  it('a project switch wipes entries and the review filter; a same-project set is a no-op', () => {
    act(() => {
      useReconcileStore.getState().setProject('p1');
      preview();
      useReconcileStore.getState().setReviewFilter(true);
    });
    const before = useReconcileStore.getState();
    expect(Object.keys(before.entries)).toHaveLength(1);
    act(() => useReconcileStore.getState().setProject('p1'));
    expect(useReconcileStore.getState()).toBe(before);
    act(() => useReconcileStore.getState().setProject('p2'));
    const after = useReconcileStore.getState();
    expect(after.entries).toEqual({});
    expect(after.reviewFilterActive).toBe(false);
    expect(after.projectId).toBe('p2');
  });

  it('only stores a working-days mask that actually changed', () => {
    const before = useReconcileStore.getState();
    act(() => useReconcileStore.getState().setWorkingDaysMask(MON_FRI_MASK));
    expect(useReconcileStore.getState()).toBe(before);
    act(() => useReconcileStore.getState().setWorkingDaysMask(0b1111111));
    expect(useReconcileStore.getState().workingDaysMask).toBe(0b1111111);
  });

  it('observes the authoritative value and marks a moved date as diverged', () => {
    act(() => {
      preview();
      useReconcileStore.getState().observe([{ taskId: 't1', field: 'start', value: '2026-05-05' }]);
    });
    const entry = useReconcileStore.getState().entries[reconcileKey('t1', 'start')];
    expect(entry.status).toBe('diverged');
  });

  it('reject records the refusal; retry drops it and re-issues the write', () => {
    const retryFn = vi.fn();
    act(() => {
      preview();
      useReconcileStore.getState().reject('t1', 'start', 'Locked baseline', retryFn);
    });
    expect(useReconcileStore.getState().entries[reconcileKey('t1', 'start')].status).toBe(
      'rejected',
    );
    act(() => useReconcileStore.getState().retry('t1', 'start'));
    expect(retryFn).toHaveBeenCalledTimes(1);
    expect(useReconcileStore.getState().entries[reconcileKey('t1', 'start')]).toBeUndefined();
    // Retrying an unknown key is a no-op.
    act(() => useReconcileStore.getState().retry('nope', 'finish'));
    expect(retryFn).toHaveBeenCalledTimes(1);
  });

  it('acknowledging the last marker turns the review filter off; earlier acks leave it on', () => {
    act(() => {
      preview('t1');
      preview('t2');
      useReconcileStore.getState().observe([
        { taskId: 't1', field: 'start', value: '2026-05-05' },
        { taskId: 't2', field: 'start', value: '2026-05-06' },
      ]);
      useReconcileStore.getState().setReviewFilter(true);
    });
    act(() => useReconcileStore.getState().acknowledge('t1', 'start'));
    expect(useReconcileStore.getState().reviewFilterActive).toBe(true);
    act(() => useReconcileStore.getState().acknowledge('t2', 'start'));
    expect(useReconcileStore.getState().reviewFilterActive).toBe(false);
  });

  it('acknowledgeAll clears every diverged marker and the filter, but keeps a rejection', () => {
    act(() => {
      preview('t1');
      preview('t2');
      useReconcileStore.getState().observe([{ taskId: 't1', field: 'start', value: '2026-05-05' }]);
      useReconcileStore.getState().reject('t2', 'start', 'Refused');
      useReconcileStore.getState().setReviewFilter(true);
    });
    act(() => useReconcileStore.getState().acknowledgeAll());
    const s = useReconcileStore.getState();
    expect(s.entries[reconcileKey('t1', 'start')]).toBeUndefined();
    expect(s.entries[reconcileKey('t2', 'start')].status).toBe('rejected');
    // A rejection still counts as something to review.
    expect(s.reviewFilterActive).toBe(true);
  });

  it('prune is an identity when nothing expired, and drops entries for unknown tasks', () => {
    act(() => {
      preview('t1');
      useReconcileStore.getState().observe([{ taskId: 't1', field: 'start', value: '2026-05-05' }]);
      useReconcileStore.getState().setReviewFilter(true);
    });
    const before = useReconcileStore.getState();
    act(() => useReconcileStore.getState().prune(new Set(['t1'])));
    expect(useReconcileStore.getState()).toBe(before);
    act(() => useReconcileStore.getState().prune(new Set(['other'])));
    expect(useReconcileStore.getState().entries).toEqual({});
    expect(useReconcileStore.getState().reviewFilterActive).toBe(false);
  });

  it('the review filter does not switch itself off while it is inactive', () => {
    act(() => {
      preview('t1');
      useReconcileStore.getState().observe([{ taskId: 't1', field: 'start', value: '2026-05-05' }]);
    });
    act(() => useReconcileStore.getState().acknowledge('t1', 'start'));
    expect(useReconcileStore.getState().reviewFilterActive).toBe(false);
  });
});
