import { describe, expect, it } from 'vitest';
import { __testing } from './useSprints';
import type { ApiSprint } from '@/types';

function sprint(overrides: Partial<ApiSprint>): ApiSprint {
  return {
    id: overrides.id ?? 'sp-id',
    server_version: 1,
    short_id: 'A1B2',
    name: 'Sprint',
    goal: '',
    start_date: '2026-04-01',
    finish_date: '2026-04-14',
    state: 'PLANNED',
    target_milestone: null,
    committed_points: null,
    committed_task_count: null,
    completed_points: null,
    completed_task_count: null,
    completion_ratio_points: null,
    completion_ratio_tasks: null,
    activated_at: null,
    closed_at: null,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

describe('useSprints — bucketByState', () => {
  it('separates closed, active, and planned sprints', () => {
    const closed1 = sprint({ id: '1', state: 'COMPLETED', start_date: '2026-01-01' });
    const closed2 = sprint({ id: '2', state: 'CANCELLED', start_date: '2026-02-01' });
    const active = sprint({ id: '3', state: 'ACTIVE', start_date: '2026-03-01' });
    const planned1 = sprint({ id: '4', state: 'PLANNED', start_date: '2026-04-01' });
    const planned2 = sprint({ id: '5', state: 'PLANNED', start_date: '2026-05-01' });

    const result = __testing.bucketByState([planned2, active, closed2, planned1, closed1]);

    expect(result.closed.map((s) => s.id)).toEqual(['1', '2']);
    expect(result.active?.id).toBe('3');
    expect(result.planned.map((s) => s.id)).toEqual(['4', '5']);
  });

  it('returns null active when no sprint is ACTIVE', () => {
    const result = __testing.bucketByState([
      sprint({ id: '1', state: 'COMPLETED' }),
      sprint({ id: '2', state: 'PLANNED' }),
    ]);
    expect(result.active).toBeNull();
  });

  it('groups CANCELLED sprints with closed (the strip greys both)', () => {
    const result = __testing.bucketByState([
      sprint({ id: '1', state: 'CANCELLED', start_date: '2026-01-01' }),
      sprint({ id: '2', state: 'COMPLETED', start_date: '2026-02-01' }),
    ]);
    expect(result.closed).toHaveLength(2);
    expect(result.planned).toHaveLength(0);
  });

  it('sorts each bucket by start_date ascending', () => {
    const result = __testing.bucketByState([
      sprint({ id: 'late', state: 'COMPLETED', start_date: '2026-03-01' }),
      sprint({ id: 'early', state: 'COMPLETED', start_date: '2026-01-01' }),
      sprint({ id: 'mid', state: 'COMPLETED', start_date: '2026-02-01' }),
    ]);
    expect(result.closed.map((s) => s.id)).toEqual(['early', 'mid', 'late']);
  });

  it('handles an empty input', () => {
    const result = __testing.bucketByState([]);
    expect(result).toEqual({ closed: [], active: null, planned: [] });
  });
});
