import { describe, it, expect } from 'vitest';
import {
  buildBlockerPatchBody,
  collapseLatestPerTask,
  optimisticBlockerPatch,
  type BlockerVars,
  type QueuedBlockerOp,
} from './blockerQueue';

function vars(partial: Partial<BlockerVars> = {}): BlockerVars {
  return {
    projectId: 'p1',
    taskId: 't1',
    kind: 'flag',
    reason: 'inspector no-show',
    blockerType: 'vendor',
    blockingTask: null,
    ...partial,
  };
}

function op(partial: Partial<QueuedBlockerOp> = {}): QueuedBlockerOp {
  return {
    ...vars(),
    baseServerVersion: 3,
    wasFlagged: false,
    queuedAt: 100,
    ...partial,
  };
}

describe('optimisticBlockerPatch', () => {
  it('flags a not-yet-flagged task with a queued (0) age so isFlagged flips true', () => {
    const patch = optimisticBlockerPatch(vars(), false);
    expect(patch.blockedReason).toBe('inspector no-show');
    expect(patch.blockerType).toBe('vendor');
    expect(patch.blockingTask).toBeNull();
    expect(patch.blockedAgeSeconds).toBe(0);
  });

  it('keeps the real age when editing an already-flagged task (no age override)', () => {
    const patch = optimisticBlockerPatch(vars({ reason: null }), true);
    expect('blockedAgeSeconds' in patch).toBe(false);
    // reason: null (no read access) must not overwrite the stored reason.
    expect('blockedReason' in patch).toBe(false);
  });

  it("maps an empty blocker type to undefined ('No type'), not ''", () => {
    const patch = optimisticBlockerPatch(vars({ blockerType: '' }), false);
    expect(patch.blockerType).toBeUndefined();
  });

  it('clears the flag and its stamps on unblock', () => {
    const patch = optimisticBlockerPatch(vars({ kind: 'unblock' }), true);
    expect(patch.blockedAgeSeconds).toBeNull();
    expect(patch.blockedReason).toBe('');
    expect(patch.blockingTask).toBeNull();
    expect(patch.blockedBy).toBeNull();
  });
});

describe('buildBlockerPatchBody', () => {
  it('sends reason + type + link for a flag', () => {
    expect(buildBlockerPatchBody(op())).toEqual({
      blocked_reason: 'inspector no-show',
      blocker_type: 'vendor',
      blocking_task: null,
    });
  });

  it('omits blocked_reason when reason is null (edit without read access)', () => {
    const body = buildBlockerPatchBody(op({ reason: null }));
    expect('blocked_reason' in body).toBe(false);
    expect(body).toEqual({ blocker_type: 'vendor', blocking_task: null });
  });

  it('clears the flag with an empty reason on unblock', () => {
    expect(buildBlockerPatchBody(op({ kind: 'unblock' }))).toEqual({ blocked_reason: '' });
  });
});

describe('collapseLatestPerTask', () => {
  it('keeps one op per task, the latest by queuedAt (LWW)', () => {
    const older = op({ taskId: 't1', queuedAt: 100, reason: 'first' });
    const newer = op({ taskId: 't1', queuedAt: 200, reason: 'second' });
    const other = op({ taskId: 't2', queuedAt: 150 });
    const collapsed = collapseLatestPerTask([older, newer, other]);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.find((o) => o.taskId === 't1')?.reason).toBe('second');
  });

  it('lets a queued unblock replace a queued flag for the same task', () => {
    const flag = op({ taskId: 't1', kind: 'flag', queuedAt: 100 });
    const unblock = op({ taskId: 't1', kind: 'unblock', queuedAt: 200 });
    const collapsed = collapseLatestPerTask([flag, unblock]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].kind).toBe('unblock');
  });
});
