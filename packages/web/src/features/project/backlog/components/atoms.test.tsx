import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import { AssigneeAvatar, SprintCommitmentChip } from './atoms';

/** Minimal Task for the atoms under test — they read only sprint + assignee fields. */
function task(over: Partial<Task>): Task {
  return { id: 'T', name: 'Story', assignees: [], ...over } as Task;
}

describe('SprintCommitmentChip (web-rule 180)', () => {
  it('shows "Pending acceptance" when the story is a post-activation injection (precedence)', () => {
    // sprintPending wins even when a sprint is set, so the two chips never double up.
    render(<SprintCommitmentChip story={task({ sprintId: 'SP1', sprintPending: true })} />);
    expect(screen.getByLabelText('Pending acceptance')).toBeInTheDocument();
    expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
  });

  it('shows "Pulled" when committed to a sprint', () => {
    render(<SprintCommitmentChip story={task({ sprintId: 'SP1', sprintPending: false })} />);
    expect(screen.getByText('Pulled')).toBeInTheDocument();
  });

  it('shows "Proposed" for a candidate with no sprint', () => {
    render(<SprintCommitmentChip story={task({ sprintId: null })} />);
    expect(screen.getByText('Proposed')).toBeInTheDocument();
  });
});

describe('AssigneeAvatar', () => {
  it('renders "Unassigned" when there are no assignees', () => {
    render(<AssigneeAvatar assignees={[]} />);
    expect(screen.getByLabelText('Unassigned')).toBeInTheDocument();
  });

  it('renders first+last initials and names the assignee', () => {
    render(<AssigneeAvatar assignees={[{ resourceId: 'R1', name: 'Lena Bauer', units: 1 }]} />);
    expect(screen.getByText('LB')).toBeInTheDocument();
    expect(screen.getByLabelText('Assigned to Lena Bauer')).toBeInTheDocument();
  });

  it('stacks a +N overflow for multiple assignees', () => {
    render(
      <AssigneeAvatar
        assignees={[
          { resourceId: 'R1', name: 'Lena Bauer', units: 1 },
          { resourceId: 'R2', name: 'Omar Reyes', units: 1 },
          { resourceId: 'R3', name: 'Ada Khan', units: 1 },
        ]}
      />,
    );
    expect(screen.getByText('LB')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Assigned to Lena Bauer, Omar Reyes, Ada Khan'),
    ).toBeInTheDocument();
  });
});
