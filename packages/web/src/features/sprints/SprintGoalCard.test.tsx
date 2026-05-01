import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SprintGoalCard } from './SprintGoalCard';
import { makeSprint } from './sprintTestFixtures';

describe('SprintGoalCard', () => {
  it('renders the goal text and SP-id chip', () => {
    render(<SprintGoalCard sprint={makeSprint({ state: 'ACTIVE' })} />);
    expect(screen.getByText(/Close out telemetry firmware/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Sprint id SP-A1B2/)).toBeInTheDocument();
  });

  it('shows date range and tasks count', () => {
    render(
      <SprintGoalCard
        sprint={makeSprint({ state: 'ACTIVE', committed_task_count: 18 })}
      />,
    );
    expect(screen.getByText(/Apr 1 – Apr 14/)).toBeInTheDocument();
    expect(screen.getByText(/^18$/)).toBeInTheDocument();
  });

  it('renders points-committed pill', () => {
    render(<SprintGoalCard sprint={makeSprint({ committed_points: 47 })} />);
    expect(screen.getByLabelText(/47 story points committed/i)).toBeInTheDocument();
  });

  it('hides day-N-of-M for non-active sprints', () => {
    render(<SprintGoalCard sprint={makeSprint({ state: 'PLANNED' })} />);
    expect(screen.queryByText(/^Day$/i)).not.toBeInTheDocument();
  });

  it('shows placeholder copy when goal is empty', () => {
    render(<SprintGoalCard sprint={makeSprint({ goal: '' })} />);
    expect(screen.getByText(/No goal set for this sprint/i)).toBeInTheDocument();
  });
});
