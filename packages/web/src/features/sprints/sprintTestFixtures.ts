import type { ApiSprint, MilestoneRollup, SprintTargetMilestone } from '@/types';

/**
 * Build a deterministic ApiSprint for tests. Override only the fields the
 * test cares about; everything else gets a sensible PLANNED-state default.
 */
export function makeSprint(overrides: Partial<ApiSprint> = {}): ApiSprint {
  return {
    id: 'sp-id',
    server_version: 1,
    short_id: 'A1B2',
    short_id_display: 'SP-A1B2',
    name: 'Telemetry & FAT prep',
    goal: 'Close out telemetry firmware channel sweep and prep FAT review.',
    notes: '',
    start_date: '2026-04-01',
    finish_date: '2026-04-14',
    state: 'PLANNED',
    target_milestone: null,
    target_milestone_detail: null,
    capacity_points: null,
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

export function makeMilestone(overrides: Partial<SprintTargetMilestone> = {}): SprintTargetMilestone {
  return {
    id: 'task-fat',
    name: 'FAT review',
    wbs_path: '1.4.2',
    finish: '2026-04-21',
    rollup: null,
    ...overrides,
  };
}

/**
 * Build a deterministic {@link MilestoneRollup} payload for tests.
 * Defaults to a healthy `points`-basis rollup at 73% with no scope change.
 */
export function makeRollup(overrides: Partial<MilestoneRollup> = {}): MilestoneRollup {
  return {
    percent_complete: 73,
    rollup_basis: 'points',
    variance_days: 3,
    sprint_scope_changed: false,
    sprint_count: 1,
    ...overrides,
  };
}
