import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import type { ApiSprint } from '@/types';
import { SprintPlanningRail } from './SprintPlanningRail';

vi.mock('@/hooks/useSprints', () => ({
  useSprintCapacity: () => ({
    data: {
      members: [],
      totals: {
        committed_hours: 0,
        available_hours: 0,
        ratio: 0,
        buffer_hours: 0,
        label: 'on_track',
        pto_days: 0,
      },
      working_days: 10,
      hours_per_day: 8,
    },
    isLoading: false,
  }),
}));
vi.mock('@/features/sprints/CapacityPreflight', () => ({
  CapacityPreflight: (props: { points?: { committed: number; capacity: number | null } }) => (
    <div data-testid="capacity-preflight">
      cap:{props.points?.committed}/{String(props.points?.capacity)}
    </div>
  ),
}));

function makeSprint(over: Partial<ApiSprint>): ApiSprint {
  return {
    id: 'sp-1',
    short_id_display: 'SP-A1',
    name: 'Sprint 1',
    state: 'PLANNED',
    start_date: '2026-06-29',
    finish_date: '2026-07-13',
    capacity_points: 24,
    target_milestone: null,
    target_milestone_detail: null,
    ...over,
  } as unknown as ApiSprint;
}

describe('SprintPlanningRail', () => {
  it('renders the planning header and wires committed points into the capacity preflight', () => {
    render(
      <SprintPlanningRail
        plannedSprint={makeSprint({})}
        committedPoints={18}
        storyCount={4}
        iterationLower="sprint"
      />,
    );
    expect(
      screen.getByRole('complementary', { name: /sprint planning summary/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('SP-A1')).toBeInTheDocument();
    expect(screen.getByTestId('capacity-preflight')).toHaveTextContent('cap:18/24');
  });

  it('shows the bound milestone with its rollup percentage', () => {
    render(
      <SprintPlanningRail
        plannedSprint={makeSprint({
          target_milestone_detail: {
            id: 'm1',
            name: 'M3 Beta cutover',
            finish: '2026-07-13',
            rollup: {
              percent_complete: 62,
              rollup_basis: 'points',
              variance_days: 0,
              sprint_scope_changed: false,
              sprint_count: 1,
            },
          },
        })}
        committedPoints={18}
        storyCount={4}
        iterationLower="sprint"
      />,
    );
    expect(screen.getByText('M3 Beta cutover')).toBeInTheDocument();
    expect(screen.getByText(/62%/)).toBeInTheDocument();
  });

  it('shows a "no milestone linked" hint when none is bound', () => {
    render(
      <SprintPlanningRail
        plannedSprint={makeSprint({ target_milestone_detail: null })}
        committedPoints={0}
        storyCount={0}
        iterationLower="sprint"
      />,
    );
    expect(screen.getByText(/No milestone linked/i)).toBeInTheDocument();
  });
});
