import { describe, it, expect } from 'vitest';
import type { ForecastDiagnostic } from '@/types';
import {
  forecastFlatGuidance,
  mapForecastDiagnostic,
  type ForecastDiagnosticWire,
} from './forecastFlatMessage';

function basis(overrides: Partial<ForecastDiagnostic>): ForecastDiagnostic {
  return {
    deterministic: true,
    reason: 'no_estimates',
    tasksTotal: 1,
    tasksWithVariance: 0,
    tasksPendingApproval: 0,
    agileTasksWithoutVelocity: 0,
    ...overrides,
  };
}

describe('forecastFlatGuidance', () => {
  it('falls back to the generic missing-estimate prompt when the basis is absent (legacy payload)', () => {
    expect(forecastFlatGuidance(undefined)).toMatch(/Add PERT estimates/i);
  });

  it('explains a backlog/empty project', () => {
    expect(forecastFlatGuidance(basis({ reason: 'no_committed_tasks' }))).toMatch(
      /no committed tasks/i,
    );
  });

  it('explains an all-complete project', () => {
    expect(forecastFlatGuidance(basis({ reason: 'all_complete' }))).toMatch(/complete/i);
  });

  it('explains estimated work that is off the critical path', () => {
    expect(forecastFlatGuidance(basis({ reason: 'estimates_off_critical_path' }))).toMatch(
      /critical path/i,
    );
  });

  it('explains pending-approval estimates and pluralizes the count', () => {
    expect(
      forecastFlatGuidance(basis({ reason: 'estimates_pending_approval', tasksPendingApproval: 1 })),
    ).toMatch(/^1 task estimate is awaiting approval/);
    expect(
      forecastFlatGuidance(basis({ reason: 'estimates_pending_approval', tasksPendingApproval: 4 })),
    ).toMatch(/^4 task estimates are awaiting approval/);
  });

  it('explains agile work with no velocity history', () => {
    expect(forecastFlatGuidance(basis({ reason: 'no_velocity_history' }))).toMatch(
      /close a sprint/i,
    );
  });

  it('prompts for PERT estimates only on the genuine no_estimates case', () => {
    expect(forecastFlatGuidance(basis({ reason: 'no_estimates' }))).toMatch(/Add PERT estimates/i);
  });

  it('does NOT blame missing estimates when estimates are merely pending', () => {
    // The regression behind #1340: a user with three-point estimates was told to add some.
    const msg = forecastFlatGuidance(basis({ reason: 'estimates_pending_approval', tasksPendingApproval: 2 }));
    expect(msg).not.toMatch(/Add PERT estimates/i);
  });
});

describe('mapForecastDiagnostic', () => {
  it('returns undefined for a legacy payload without the field', () => {
    expect(mapForecastDiagnostic(undefined)).toBeUndefined();
  });

  it('maps the snake_case wire shape to camelCase', () => {
    const wire: ForecastDiagnosticWire = {
      deterministic: true,
      reason: 'estimates_pending_approval',
      tasks_total: 12,
      tasks_with_variance: 0,
      tasks_pending_approval: 8,
      agile_tasks_without_velocity: 0,
    };
    expect(mapForecastDiagnostic(wire)).toEqual({
      deterministic: true,
      reason: 'estimates_pending_approval',
      tasksTotal: 12,
      tasksWithVariance: 0,
      tasksPendingApproval: 8,
      agileTasksWithoutVelocity: 0,
    });
  });
});
