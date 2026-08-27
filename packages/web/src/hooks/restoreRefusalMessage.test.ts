/**
 * `restoreRefusalMessage` — the copy for a refused task restore (#3071).
 *
 * The point of the helper is that a 409 from `POST /tasks/:id/restore/` is *not*
 * retryable: the task's WBS position belongs to another live task until somebody moves
 * it. Both restore surfaces used to show "try again", which is advice that cannot work.
 * So these tests are as much about what the helper declines to claim as what it returns —
 * anything it cannot positively identify as that refusal must fall through to the
 * caller's generic copy rather than surfacing a half-understood server payload.
 */

import { describe, expect, it } from 'vitest';

import { restoreRefusalMessage } from './useTaskMutations';

/** Shaped so the real `axios.isAxiosError` recognizes it (it checks `isAxiosError`). */
function axiosError(status: number, data: unknown): unknown {
  return { isAxiosError: true, response: { status, data } };
}

describe('restoreRefusalMessage', () => {
  it('returns the server sentence for a wbs_path_occupied refusal', () => {
    const detail = 'WBS position 3 is now held by "Build". Move that task, then restore this one.';
    expect(restoreRefusalMessage(axiosError(409, { code: 'wbs_path_occupied', detail }))).toBe(
      detail,
    );
  });

  it('declines a 409 that is some other conflict', () => {
    expect(
      restoreRefusalMessage(axiosError(409, { code: 'shape_changed', detail: 'Shape moved.' })),
    ).toBeNull();
  });

  it('declines a non-409 status even with the right code', () => {
    expect(
      restoreRefusalMessage(axiosError(400, { code: 'wbs_path_occupied', detail: 'nope' })),
    ).toBeNull();
  });

  it('declines when detail is missing or not a string', () => {
    expect(restoreRefusalMessage(axiosError(409, { code: 'wbs_path_occupied' }))).toBeNull();
    expect(
      restoreRefusalMessage(axiosError(409, { code: 'wbs_path_occupied', detail: { a: 1 } })),
    ).toBeNull();
  });

  it('declines anything that is not an axios error', () => {
    expect(restoreRefusalMessage(new Error('offline'))).toBeNull();
    expect(restoreRefusalMessage(null)).toBeNull();
    expect(restoreRefusalMessage(undefined)).toBeNull();
  });
});
