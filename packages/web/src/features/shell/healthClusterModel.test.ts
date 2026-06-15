import { describe, it, expect } from 'vitest';
import { healthClusterModel, sprintDay, type HealthClusterInput } from './healthClusterModel';
import type { ApiSprint, ShellStats } from '@/types';
import type { ProjectVelocity } from '@/hooks/useSprints';

const STATS: ShellStats = {
  taskCount: 42,
  criticalPathCount: 3,
  monteCarlop80: '2026-11-03',
  atRiskCount: 2,
  criticalCount: 1,
  atRiskTasks: [{ id: 't4', wbs: '1.3', name: 'Frontend Build' }],
  criticalTasks: [{ id: 't3', wbs: '1.2', name: 'Backend Implementation' }],
  onlineUsers: 0,
  lastSaved: null,
  recalculatedAt: null,
};

// The selector only reads start_date/finish_date/name + the four points/count
// fields; partial cast keeps the fixture honest to what's exercised.
function sprint(overrides: Partial<ApiSprint>): ApiSprint {
  return {
    name: 'Sprint 7',
    start_date: '2026-06-08',
    finish_date: '2026-06-19',
    committed_points: 40,
    completed_points: 32,
    committed_task_count: 18,
    completed_task_count: 12,
    ...overrides,
  } as ApiSprint;
}

const VELOCITY: ProjectVelocity = {
  sprints: [],
  rolling_avg_points: 24,
  rolling_stdev_points: 4,
  forecast_range_low: 18,
  forecast_range_high: 30,
  rolling_avg_tasks: null,
  rolling_stdev_tasks: null,
  team_velocity_per_day: 2.4,
  excluded_count: 0,
};

const MC = { p50: '2026-10-05', p80: '2026-11-03' };

function input(over: Partial<HealthClusterInput>): HealthClusterInput {
  return {
    methodology: 'AGILE',
    stats: STATS,
    activeSprint: sprint({}),
    velocity: VELOCITY,
    mc: MC,
    now: new Date('2026-06-10T12:00:00Z'),
    ...over,
  };
}

describe('sprintDay', () => {
  it('is 1-based inclusive (Mon→Fri = 5 days, Wed = Day 3/5)', () => {
    // 2026-06-08 is a Monday; finish 2026-06-12 Friday.
    expect(sprintDay('2026-06-08', '2026-06-12', new Date('2026-06-10T08:00:00Z'))).toEqual({
      dayN: 3,
      dayM: 5,
    });
  });

  it('clamps before-start to Day 1 and after-finish to the last day', () => {
    expect(sprintDay('2026-06-08', '2026-06-12', new Date('2026-06-01T00:00:00Z')).dayN).toBe(1);
    expect(sprintDay('2026-06-08', '2026-06-12', new Date('2026-06-30T00:00:00Z')).dayN).toBe(5);
  });
});

describe('healthClusterModel', () => {
  it('WATERFALL → Forecast · At-risk · Critical', () => {
    const segs = healthClusterModel(input({ methodology: 'WATERFALL' }));
    expect(segs.map((s) => s.kind)).toEqual(['forecast', 'atRisk', 'critical']);
  });

  it('HYBRID → Sprint · Forecast · Critical', () => {
    const segs = healthClusterModel(input({ methodology: 'HYBRID' }));
    expect(segs.map((s) => s.kind)).toEqual(['sprint', 'forecast', 'critical']);
  });

  it('AGILE → Sprint · Points · Velocity', () => {
    const segs = healthClusterModel(input({ methodology: 'AGILE' }));
    expect(segs.map((s) => s.kind)).toEqual(['sprint', 'points', 'velocity']);
  });

  it('forecast carries the P50·P80 band, or p80 null when the scheduler has not run', () => {
    const segs = healthClusterModel(input({ methodology: 'WATERFALL' }));
    expect(segs[0]).toMatchObject({ kind: 'forecast', p50: '2026-10-05', p80: '2026-11-03' });
    const none = healthClusterModel(
      input({ methodology: 'WATERFALL', stats: { ...STATS, monteCarlop80: null } }),
    );
    expect(none[0]).toMatchObject({ kind: 'forecast', p80: null });
  });

  it('forecast P50 is null (P80 alone) when no MC distribution is cached', () => {
    const segs = healthClusterModel(input({ methodology: 'WATERFALL', mc: undefined }));
    expect(segs[0]).toMatchObject({ kind: 'forecast', p50: null, p80: '2026-11-03' });
  });

  it('no active sprint → sprintEmpty and the Points slot is omitted (AGILE 2 segments)', () => {
    const segs = healthClusterModel(input({ methodology: 'AGILE', activeSprint: null }));
    expect(segs.map((s) => s.kind)).toEqual(['sprintEmpty', 'velocity']);
  });

  it('Points uses points when sized in points', () => {
    const segs = healthClusterModel(input({ methodology: 'AGILE' }));
    expect(segs[1]).toEqual({ kind: 'points', completed: 32, committed: 40, unit: 'pts' });
  });

  it('Points falls back to item count when the team does not size in points (#1161)', () => {
    const segs = healthClusterModel(
      input({ methodology: 'AGILE', activeSprint: sprint({ committed_points: null }) }),
    );
    expect(segs[1]).toEqual({ kind: 'points', completed: 12, committed: 18, unit: 'items' });
  });

  it('Points is omitted entirely when neither points nor counts exist', () => {
    const segs = healthClusterModel(
      input({
        methodology: 'AGILE',
        activeSprint: sprint({ committed_points: null, committed_task_count: null }),
      }),
    );
    expect(segs.map((s) => s.kind)).toEqual(['sprint', 'velocity']);
  });

  it('velocity is gated (no number) when the server suppresses it (ADR-0104)', () => {
    const segs = healthClusterModel(
      input({ methodology: 'AGILE', velocity: { ...VELOCITY, velocity_suppressed: true } }),
    );
    expect(segs[segs.length - 1]).toEqual({ kind: 'velocityGated' });
    // the suppressed number never enters the model
    expect(JSON.stringify(segs)).not.toContain('24');
  });

  it('velocity carries avg + range + excluded count when in-audience', () => {
    const segs = healthClusterModel(
      input({ methodology: 'AGILE', velocity: { ...VELOCITY, excluded_count: 1 } }),
    );
    expect(segs[2]).toEqual({ kind: 'velocity', avg: 24, low: 18, high: 30, excluded: 1 });
  });

  it('velocity avg is null when there is not enough history', () => {
    const segs = healthClusterModel(
      input({ methodology: 'AGILE', velocity: { ...VELOCITY, rolling_avg_points: null } }),
    );
    expect(segs[2]).toMatchObject({ kind: 'velocity', avg: null });
  });
});
