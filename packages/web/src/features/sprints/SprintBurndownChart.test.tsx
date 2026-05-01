import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SprintBurndownChart } from './SprintBurndownChart';
import { makeSprint } from './sprintTestFixtures';
import type { SprintBurnSnapshot } from '@/hooks/useSprints';

const ACTIVE = makeSprint({
  state: 'ACTIVE',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  committed_points: 40,
});

function snap(overrides: Partial<SprintBurnSnapshot>): SprintBurnSnapshot {
  return {
    id: overrides.id ?? `sn-${overrides.snapshot_date}`,
    snapshot_date: overrides.snapshot_date ?? '2026-04-01',
    remaining_points: overrides.remaining_points ?? 40,
    remaining_task_count: 0,
    completed_points: overrides.completed_points ?? 0,
    completed_task_count: 0,
    scope_change_points: overrides.scope_change_points ?? 0,
    scope_change_task_count: 0,
    created_at: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

describe('SprintBurndownChart', () => {
  it('renders the section heading and remaining/days-left summary', () => {
    render(
      <SprintBurndownChart
        sprint={ACTIVE}
        snapshots={[snap({ snapshot_date: '2026-04-01', remaining_points: 40 })]}
        today={new Date('2026-04-04T12:00:00Z')}
      />,
    );
    expect(screen.getByText(/Sprint Burndown/i)).toBeInTheDocument();
    expect(screen.getByText(/working days left/i)).toBeInTheDocument();
  });

  it('renders the today marker with TODAY text inside the window', () => {
    render(
      <SprintBurndownChart
        sprint={ACTIVE}
        snapshots={[snap({ snapshot_date: '2026-04-01', remaining_points: 40 })]}
        today={new Date('2026-04-07T12:00:00Z')}
      />,
    );
    expect(screen.getByText('TODAY')).toBeInTheDocument();
  });

  it('uses semantic-on-track when actual is ahead of ideal', () => {
    // Day 7 of 14 → ideal remaining = 20; actual remaining = 10 → ahead by 10.
    render(
      <SprintBurndownChart
        sprint={ACTIVE}
        snapshots={[
          snap({ snapshot_date: '2026-04-07', remaining_points: 10 }),
        ]}
        today={new Date('2026-04-07T12:00:00Z')}
      />,
    );
    const trend = screen.getByText(/ahead of ideal/i);
    expect(trend.className).toMatch(/text-semantic-on-track/);
  });

  it('uses semantic-at-risk when actual is behind ideal', () => {
    render(
      <SprintBurndownChart
        sprint={ACTIVE}
        snapshots={[
          snap({ snapshot_date: '2026-04-07', remaining_points: 35 }),
        ]}
        today={new Date('2026-04-07T12:00:00Z')}
      />,
    );
    const trend = screen.getByText(/behind of ideal/i);
    expect(trend.className).toMatch(/text-semantic-at-risk/);
  });

  it('surfaces a scope-add callout when a snapshot has scope_change_points', () => {
    render(
      <SprintBurndownChart
        sprint={ACTIVE}
        snapshots={[
          snap({ snapshot_date: '2026-04-01', remaining_points: 40 }),
          snap({ snapshot_date: '2026-04-05', remaining_points: 47, scope_change_points: 7 }),
        ]}
        today={new Date('2026-04-07T12:00:00Z')}
      />,
    );
    expect(screen.getByText(/scope-add 2026-04-05/)).toBeInTheDocument();
    expect(screen.getByText(/\+7 pts/)).toBeInTheDocument();
  });
});
