import { screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { SprintPlanningBridge } from './SprintPlanningBridge';
import { makeSprint, makeMilestone } from './sprintTestFixtures';

describe('SprintPlanningBridge', () => {
  it('frames the draft goal next to the advancing milestone', () => {
    renderWithRouter(
      <SprintPlanningBridge
        sprint={makeSprint({ target_milestone_detail: makeMilestone() })}
        projectId="proj-1"
        canEdit={false}
        sprintTaskIds={[]}
      />,
    );
    expect(screen.getByText(/Planning bridge/i)).toBeInTheDocument();
    expect(screen.getByText('Draft sprint goal')).toBeInTheDocument();
    expect(screen.getByText('FAT review')).toBeInTheDocument();
  });

  it('shows how many predecessor tasks land in this sprint', () => {
    renderWithRouter(
      <SprintPlanningBridge
        sprint={makeSprint({
          target_milestone_detail: makeMilestone({ predecessor_ids: ['a', 'b'] }),
        })}
        projectId="proj-1"
        canEdit={false}
        sprintTaskIds={['a', 'z']} // only 'a' is a predecessor in the sprint
      />,
    );
    // "1 of 2 predecessor tasks land in this sprint" — split across mono spans.
    const caption = screen.getByText(/predecessor tasks land in this sprint/);
    expect(caption.textContent).toMatch(/1\s+of\s+2/);
  });

  it('omits the predecessor caption when the milestone has no predecessors', () => {
    renderWithRouter(
      <SprintPlanningBridge
        sprint={makeSprint({ target_milestone_detail: makeMilestone({ predecessor_ids: [] }) })}
        projectId="proj-1"
        canEdit={false}
        sprintTaskIds={['a']}
      />,
    );
    expect(screen.queryByText(/land in this sprint/)).not.toBeInTheDocument();
  });
});
