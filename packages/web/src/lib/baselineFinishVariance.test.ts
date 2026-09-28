import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import { baselineFinishVariance } from './baselineFinishVariance';

function task(overrides: Partial<Task>): Task {
  return { id: 't', finish: '2026-04-20', ...overrides } as unknown as Task;
}

describe('baselineFinishVariance (#4203)', () => {
  it('reads the server working-time value when the payload carries it', () => {
    // Shown days differ by 3 across a weekend; the server measured 0.
    expect(
      baselineFinishVariance(task({ baselineFinish: '2026-04-17', baselineFinishVarianceDays: 0 })),
    ).toBe(0);
  });

  it('trusts a server null (no forecast or no baseline finish)', () => {
    expect(
      baselineFinishVariance(
        task({ baselineFinish: '2026-04-17', baselineFinishVarianceDays: null }),
      ),
    ).toBeNull();
  });

  it('falls back to the shown-day difference when the field is absent', () => {
    expect(baselineFinishVariance(task({ baselineFinish: '2026-04-17' }))).toBe(3);
    expect(baselineFinishVariance(task({ baselineFinish: '2026-04-24' }))).toBe(-4);
  });

  it('is null when the task is not baselined', () => {
    expect(baselineFinishVariance(task({ baselineFinish: undefined }))).toBeNull();
  });
});
