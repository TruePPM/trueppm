import { describe, expect, it } from 'vitest';
import { cascadeLine } from './commitCascadeLine';

const base = { taskId: 't1', movedCount: 3, finishDeltaDays: 0 as number | null };

describe('cascadeLine', () => {
  it('returns null with no summary or for a different task', () => {
    expect(cascadeLine(null)).toBeNull();
    expect(cascadeLine(undefined)).toBeNull();
    expect(cascadeLine(base, 'other')).toBeNull();
  });

  it('pluralizes the downstream count', () => {
    expect(cascadeLine({ ...base, movedCount: 0 })).toBe(
      'No downstream tasks move; finish unchanged',
    );
    expect(cascadeLine({ ...base, movedCount: 1 })).toBe(
      '1 downstream task moves; finish unchanged',
    );
    expect(cascadeLine(base, 't1')).toBe('3 downstream tasks move; finish unchanged');
  });

  it('names the direction and size of a finish shift', () => {
    expect(cascadeLine({ ...base, finishDeltaDays: 4 })).toBe(
      '3 downstream tasks move; finish 4d later',
    );
    expect(cascadeLine({ ...base, finishDeltaDays: -2 })).toBe(
      '3 downstream tasks move; finish 2d earlier',
    );
  });

  it('drops the finish clause when the shift is unknowable', () => {
    expect(cascadeLine({ ...base, finishDeltaDays: null })).toBe('3 downstream tasks move');
  });
});
