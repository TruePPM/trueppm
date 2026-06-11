import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SprintGoalCard, evaluateSprintGoal } from './SprintGoalCard';
import { makeSprint } from './sprintTestFixtures';

const updateMutate = vi.fn();
const updateSprint = { mutate: updateMutate, isPending: false, isError: false };

vi.mock('@/hooks/useSprints', () => ({
  useSprintMutations: () => ({
    createSprint: { mutate: vi.fn(), isPending: false, isError: false },
    closeSprint: { mutate: vi.fn(), isPending: false, isError: false },
    activateSprint: { mutate: vi.fn(), isPending: false, isError: false },
    updateSprint,
  }),
}));

function renderCard(props: Partial<Parameters<typeof SprintGoalCard>[0]> = {}) {
  return render(
    <SprintGoalCard sprint={makeSprint({ state: 'ACTIVE' })} projectId="proj-1" {...props} />,
  );
}

beforeEach(() => {
  updateMutate.mockReset();
  updateSprint.isPending = false;
  updateSprint.isError = false;
});

describe('SprintGoalCard — banner (read) state', () => {
  it('renders the goal text and SP-id chip', () => {
    renderCard();
    expect(screen.getByText(/Close out telemetry firmware/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Sprint id SP-A1B2/)).toBeInTheDocument();
  });

  it('shows date range and tasks count', () => {
    renderCard({ sprint: makeSprint({ state: 'ACTIVE', committed_task_count: 18 }) });
    expect(screen.getByText(/Apr 1 – Apr 14/)).toBeInTheDocument();
    expect(screen.getByText(/^18$/)).toBeInTheDocument();
  });

  it('renders points-committed pill', () => {
    renderCard({ sprint: makeSprint({ committed_points: 47 }) });
    expect(screen.getByLabelText(/47 story points committed/i)).toBeInTheDocument();
  });

  it('hides day-N-of-M for non-active sprints', () => {
    renderCard({ sprint: makeSprint({ state: 'PLANNED' }) });
    expect(screen.queryByText(/^Day$/i)).not.toBeInTheDocument();
  });

  it('shows placeholder copy when goal is empty', () => {
    renderCard({ sprint: makeSprint({ goal: '' }) });
    expect(screen.getByText(/No goal set for this sprint/i)).toBeInTheDocument();
  });
});

describe('SprintGoalCard — edit affordance + role gate', () => {
  it('hides the Edit button when canEdit is false', () => {
    renderCard({ canEdit: false });
    expect(screen.queryByRole('button', { name: /^Edit$/ })).not.toBeInTheDocument();
  });

  it('shows the Edit button when canEdit is true', () => {
    renderCard({ canEdit: true });
    expect(screen.getByRole('button', { name: /^Edit$/ })).toBeInTheDocument();
  });

  it('enters edit mode with a textarea and the three good-goal hints', () => {
    renderCard({ canEdit: true });
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByText(/Describes an outcome, not a checklist/)).toBeInTheDocument();
    expect(screen.getByText(/Single, focused theme/)).toBeInTheDocument();
    expect(screen.getByText(/Has a way to know it's met/)).toBeInTheDocument();
  });
});

describe('SprintGoalCard — saving', () => {
  it('Save is disabled until the goal changes', () => {
    renderCard({ canEdit: true });
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect(screen.getByRole('button', { name: /Save goal/ })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Telemetry failover is load-proven end to end.' },
    });
    expect(screen.getByRole('button', { name: /Save goal/ })).toBeEnabled();
  });

  it('Save calls updateSprint.mutate with the trimmed goal payload', () => {
    renderCard({ canEdit: true });
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '  Failover is proven live  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save goal/ }));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toEqual({
      sprintId: 'sp-id',
      payload: { goal: 'Failover is proven live' },
    });
  });

  it('Cancel exits edit mode without mutating', () => {
    renderCard({ canEdit: true });
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(updateMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('surfaces an error alert when the mutation fails', () => {
    updateSprint.isError = true;
    renderCard({ canEdit: true });
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to save the goal/i);
  });
});

describe('evaluateSprintGoal heuristics', () => {
  it('flags a strong single-outcome goal as outcome + single + measurable', () => {
    const q = evaluateSprintGoal(
      'Telemetry failover is load-proven so the FAT review can demo a live link cut.',
    );
    expect(q.outcome).toBe(true);
    expect(q.single).toBe(true);
    expect(q.measurable).toBe(true);
  });

  it('does not flag a bulleted checklist as an outcome or single theme', () => {
    const q = evaluateSprintGoal('- wire rig\n- run test\n- write deck');
    expect(q.outcome).toBe(false);
    expect(q.single).toBe(false);
  });

  it('treats a multi-"and" laundry list as neither outcome nor single', () => {
    const q = evaluateSprintGoal('Do auth and billing and search and export work');
    expect(q.outcome).toBe(false);
    expect(q.single).toBe(false);
  });

  it('returns all-false for an empty or trivially short goal', () => {
    expect(evaluateSprintGoal('')).toEqual({
      outcome: false,
      single: false,
      measurable: false,
    });
    expect(evaluateSprintGoal('go')).toEqual({
      outcome: false,
      single: false,
      measurable: false,
    });
  });
});
