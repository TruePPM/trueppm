import { describe, it, expect } from 'vitest';
import {
  buildStatusPatchBody,
  collapseLatestPerTask,
  hasServerAdvanced,
  optimisticStatusPatch,
  type QueuedCardStatusOp,
} from './cardStatusQueue';

function op(partial: Partial<QueuedCardStatusOp>): QueuedCardStatusOp {
  return {
    taskId: 't1',
    projectId: 'p1',
    status: 'IN_PROGRESS',
    baseServerVersion: 1,
    queuedAt: 100,
    ...partial,
  };
}

describe('hasServerAdvanced', () => {
  it('is true when the server version moved ahead of the queued base', () => {
    expect(hasServerAdvanced(3, 4)).toBe(true);
  });

  it('is false when the server version is unchanged', () => {
    expect(hasServerAdvanced(3, 3)).toBe(false);
  });

  it('is false when the server version is somehow behind the base', () => {
    expect(hasServerAdvanced(5, 4)).toBe(false);
  });

  it('treats a missing base or current version as no-conflict', () => {
    expect(hasServerAdvanced(null, 4)).toBe(false);
    expect(hasServerAdvanced(3, null)).toBe(false);
    expect(hasServerAdvanced(null, null)).toBe(false);
  });
});

describe('collapseLatestPerTask (last-write-wins per task)', () => {
  it('keeps only the latest op per task by queuedAt', () => {
    const result = collapseLatestPerTask([
      op({ taskId: 't1', status: 'NOT_STARTED', queuedAt: 100 }),
      op({ taskId: 't1', status: 'REVIEW', queuedAt: 200 }),
      op({ taskId: 't2', status: 'ON_HOLD', queuedAt: 150 }),
    ]);
    expect(result).toHaveLength(2);
    const t1 = result.find((o) => o.taskId === 't1');
    expect(t1?.status).toBe('REVIEW');
    expect(result.find((o) => o.taskId === 't2')?.status).toBe('ON_HOLD');
  });

  it('does not reorder when a later array element has an equal timestamp', () => {
    const result = collapseLatestPerTask([
      op({ taskId: 't1', status: 'NOT_STARTED', queuedAt: 100 }),
      op({ taskId: 't1', status: 'COMPLETE', queuedAt: 100 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('COMPLETE');
  });

  it('returns an empty list for no ops', () => {
    expect(collapseLatestPerTask([])).toEqual([]);
  });
});

describe('optimisticStatusPatch', () => {
  it('always sets status', () => {
    expect(optimisticStatusPatch({ projectId: 'p1', taskId: 't1', status: 'REVIEW' })).toEqual({
      status: 'REVIEW',
    });
  });

  it('maps the "root" parent sentinel to null and passes real parents through', () => {
    expect(
      optimisticStatusPatch({ projectId: 'p1', taskId: 't1', status: 'REVIEW', parentId: 'root' }),
    ).toEqual({ status: 'REVIEW', parentId: null });
    expect(
      optimisticStatusPatch({ projectId: 'p1', taskId: 't1', status: 'REVIEW', parentId: 'ph2' }),
    ).toEqual({ status: 'REVIEW', parentId: 'ph2' });
  });

  it('includes sprintId only when supplied', () => {
    expect(
      optimisticStatusPatch({ projectId: 'p1', taskId: 't1', status: 'REVIEW', sprintId: 's9' }),
    ).toEqual({ status: 'REVIEW', sprintId: 's9' });
  });
});

describe('buildStatusPatchBody', () => {
  it('produces the same snake_case body the online path sends', () => {
    expect(
      buildStatusPatchBody(op({ status: 'REVIEW', parentId: 'root', sprintId: 's9' })),
    ).toEqual({ status: 'REVIEW', parent_id: null, sprint_id: 's9' });
  });

  it('omits parent_id and sprint_id when not part of the move', () => {
    expect(buildStatusPatchBody(op({ status: 'IN_PROGRESS', parentId: undefined }))).toEqual({
      status: 'IN_PROGRESS',
    });
  });
});
