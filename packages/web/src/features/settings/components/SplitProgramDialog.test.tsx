import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SplitProgramDialog } from './SplitProgramDialog';

// Mutable, hoisted projects result so individual tests can flip to the empty
// case (vi.mock is hoisted above the file, so it cannot close over a plain let).
const { projectsState } = vi.hoisted(() => ({
  projectsState: {
    current: { data: [] as { id: string; name: string }[] | undefined, isLoading: false },
  },
}));

vi.mock('@/hooks/useProgramProjects', () => ({
  useProgramProjects: () => projectsState.current,
}));

function setup(overrides: Partial<ComponentProps<typeof SplitProgramDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <SplitProgramDialog
      programId="p-1"
      programName="Phase 2"
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

beforeEach(() => {
  projectsState.current = {
    data: [
      { id: 'proj-a', name: 'Apollo' },
      { id: 'proj-b', name: 'Beacon' },
    ],
    isLoading: false,
  };
});

describe('SplitProgramDialog', () => {
  it('gates confirm until every sub-program is named', async () => {
    const user = userEvent.setup();
    setup();
    const confirm = screen.getByRole('button', { name: 'Split program' });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText('Sub-program 1 name'), 'Alpha');
    await waitFor(() => expect(confirm).toBeEnabled());
  });

  it('groups projects by their target sub-program in the payload', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();

    await user.type(screen.getByLabelText('Sub-program 1 name'), 'Alpha');
    await user.click(screen.getByRole('button', { name: '+ Add sub-program' }));
    await user.type(screen.getByLabelText('Sub-program 2 name'), 'Beta');

    await user.selectOptions(screen.getByLabelText('Assign project Apollo to'), 'sub-0');
    await user.selectOptions(screen.getByLabelText('Assign project Beacon to'), 'sub-1');

    await user.click(screen.getByRole('button', { name: 'Split program' }));
    expect(onConfirm).toHaveBeenCalledWith([
      { name: 'Alpha', project_ids: ['proj-a'] },
      { name: 'Beta', project_ids: ['proj-b'] },
    ]);
  });

  it('leaves unassigned projects out of the payload (they stay on the original)', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();

    await user.type(screen.getByLabelText('Sub-program 1 name'), 'Alpha');
    await user.selectOptions(screen.getByLabelText('Assign project Apollo to'), 'sub-0');
    // Beacon is left on "Stays on Phase 2".

    await user.click(screen.getByRole('button', { name: 'Split program' }));
    expect(onConfirm).toHaveBeenCalledWith([{ name: 'Alpha', project_ids: ['proj-a'] }]);
  });

  it('returns a removed sub-program’s projects to the original', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();

    await user.type(screen.getByLabelText('Sub-program 1 name'), 'Alpha');
    await user.click(screen.getByRole('button', { name: '+ Add sub-program' }));
    await user.type(screen.getByLabelText('Sub-program 2 name'), 'Beta');
    await user.selectOptions(screen.getByLabelText('Assign project Apollo to'), 'sub-1');

    await user.click(screen.getByRole('button', { name: 'Remove sub-program 2' }));
    await user.click(screen.getByRole('button', { name: 'Split program' }));

    // Apollo fell back to the original; Alpha keeps no projects.
    expect(onConfirm).toHaveBeenCalledWith([{ name: 'Alpha', project_ids: [] }]);
  });

  it('allows splitting a program with no projects into empty shells', async () => {
    projectsState.current = { data: [], isLoading: false };
    const user = userEvent.setup();
    const { onConfirm } = setup();

    expect(screen.getByRole('note')).toHaveTextContent(/no projects/i);

    await user.type(screen.getByLabelText('Sub-program 1 name'), 'Alpha');
    await user.click(screen.getByRole('button', { name: 'Split program' }));
    expect(onConfirm).toHaveBeenCalledWith([{ name: 'Alpha', project_ids: [] }]);
  });

  it('surfaces the server error verbatim', () => {
    setup({ error: 'Project X is not a project of this program.' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Project X is not a project of this program.',
    );
  });

  it('Cancel invokes onCancel without confirming', async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
