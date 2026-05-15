/**
 * Progress-anchor gate helpers (issue #362 / ADR-0057).
 *
 * Covers `parseProgressAnchorError` — server-error → typed payload. The
 * mutation hooks themselves are tested elsewhere; this file isolates the
 * pure parser so a failing case directly fingers the parser.
 */
import { describe, it, expect } from 'vitest';
import { parseProgressAnchorError } from './useTaskMutations';

describe('parseProgressAnchorError', () => {
  function makeAxiosError(data: unknown) {
    return { response: { data } };
  }

  it('returns the typed payload when code is progress_requires_anchor', () => {
    const payload = {
      code: 'progress_requires_anchor',
      detail: 'Cannot record progress without a planned start date or sprint assignment.',
      suggested_action: 'set_planned_start',
    };
    const result = parseProgressAnchorError(makeAxiosError(payload));
    expect(result).toEqual(payload);
  });

  it('returns null for a cyclic_dependency error (different code)', () => {
    const payload = { detail: 'cyclic_dependency', cycle: [] };
    expect(parseProgressAnchorError(makeAxiosError(payload))).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseProgressAnchorError(null)).toBeNull();
  });

  it('returns null for a plain Error object', () => {
    expect(parseProgressAnchorError(new Error('network'))).toBeNull();
  });

  it('returns null when response.data is missing', () => {
    expect(parseProgressAnchorError({ message: 'no response' })).toBeNull();
  });

  it('returns null when code is absent', () => {
    const payload = {
      detail: 'Cannot record progress without a planned start date or sprint assignment.',
      suggested_action: 'set_planned_start',
    };
    expect(parseProgressAnchorError(makeAxiosError(payload))).toBeNull();
  });
});
