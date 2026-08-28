import { describe, it, expect } from 'vitest';
import type { TaskBulkResponse } from '@/hooks/useTaskMutations';
import {
  buildStoryCommitOperations,
  reconcileStoryCommit,
  type CommittedStoryRef,
} from './storyCommitReconcile';

const SENT: CommittedStoryRef[] = [
  { id: 's1', name: 'Ready story A' },
  { id: 's2', name: 'Ready story B' },
  { id: 's3', name: 'Unrefined story C' },
];

function response(over: Partial<TaskBulkResponse> = {}): TaskBulkResponse {
  return {
    applied: [],
    rejected: [],
    skipped: [],
    capabilities_denied: [],
    operation_id: null,
    ...over,
  };
}

function applied(index: number, id: string) {
  return { index, id, op: 'update' as const, outcome: 'updated' as const };
}

describe('buildStoryCommitOperations', () => {
  it('emits one update op per story, in selection order, writing only `sprint`', () => {
    expect(buildStoryCommitOperations(['s1', 's2'], 'sp-1')).toEqual([
      { op: 'update', id: 's1', data: { sprint: 'sp-1' } },
      { op: 'update', id: 's2', data: { sprint: 'sp-1' } },
    ]);
  });

  it('emits an empty batch for an empty selection rather than a placeholder row', () => {
    expect(buildStoryCommitOperations([], 'sp-1')).toEqual([]);
  });
});

describe('reconcileStoryCommit', () => {
  it('reports a fully-applied batch as clean', () => {
    const out = reconcileStoryCommit(SENT.slice(0, 2), {
      ...response({ applied: [applied(0, 's1'), applied(1, 's2')] }),
    });
    expect(out.isClean).toBe(true);
    expect(out.committedCount).toBe(2);
    expect(out.sentCount).toBe(2);
    expect(out.rejected).toEqual([]);
    expect(out.retryIds).toEqual([]);
  });

  it('names a rejected row from its `operations` index and carries the server reason', () => {
    const out = reconcileStoryCommit(SENT, {
      ...response({
        applied: [applied(0, 's1'), applied(2, 's3')],
        rejected: [
          { index: 1, id: 's2', code: 'forbidden', message: 'You may not edit this task.' },
        ],
      }),
    });
    expect(out.isClean).toBe(false);
    expect(out.committedCount).toBe(2);
    expect(out.rejected).toEqual([
      {
        index: 1,
        id: 's2',
        name: 'Ready story B',
        code: 'forbidden',
        reason: 'You may not edit this task.',
      },
    ]);
    expect(out.retryIds).toEqual(['s2']);
  });

  it('correlates by index, not by the echoed id — a null id still names its story', () => {
    // `index` is the batch's correlation handle (ADR-0772 §2): the server rejects
    // some rows before it has an id to echo, so a client keyed on `id` loses the row.
    const out = reconcileStoryCommit(SENT, {
      ...response({
        rejected: [
          { index: 2, id: null, code: 'malformed_id', message: "'id' is not a valid UUID." },
        ],
      }),
    });
    expect(out.rejected[0].name).toBe('Unrefined story C');
    // The id we SENT is authoritative — the response could not supply one.
    expect(out.rejected[0].id).toBe('s3');
    expect(out.retryIds).toEqual(['s3']);
  });

  it('keeps skipped rows out of the retry set — the server already called them no-ops', () => {
    const out = reconcileStoryCommit(SENT, {
      ...response({
        applied: [applied(0, 's1')],
        skipped: [
          { index: 1, id: 's2', code: 'tombstoned', message: 'That id belongs to a deleted row.' },
        ],
        rejected: [
          { index: 2, id: 's3', code: 'invalid', message: 'name: This field is required.' },
        ],
      }),
    });
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].name).toBe('Ready story B');
    expect(out.retryIds).toEqual(['s3']);
    expect(out.isClean).toBe(false);
  });

  it('is not clean when a row is unaccounted for, even with nothing rejected or skipped', () => {
    // Defensive: every op should land in exactly one bucket, but closing the modal
    // on a silent shortfall would claim a commit the response does not support.
    const out = reconcileStoryCommit(SENT, { ...response({ applied: [applied(0, 's1')] }) });
    expect(out.isClean).toBe(false);
    expect(out.committedCount).toBe(1);
    expect(out.sentCount).toBe(3);
  });

  it('falls back to a neutral label when an index has no matching sent row', () => {
    const out = reconcileStoryCommit(SENT.slice(0, 1), {
      ...response({
        rejected: [{ index: 7, id: null, code: 'invalid', message: 'Unknown op.' }],
      }),
    });
    expect(out.rejected[0].name).toBe('This story');
    expect(out.rejected[0].id).toBeNull();
    expect(out.retryIds).toEqual([]);
  });
});
