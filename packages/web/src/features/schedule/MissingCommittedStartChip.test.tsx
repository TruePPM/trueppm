import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingCommittedStartChip } from './MissingCommittedStartChip';
import type { Task } from '@/types';

const mutate = vi.fn();
vi.mock('@/hooks/useTaskMutations', () => ({
  useUpdateTask: () => ({ mutate, isPending: false }),
}));

const TASK = {
  id: 't-1',
  start: '2026-04-05',
  status: 'IN_PROGRESS',
  plannedStart: null,
} as unknown as Task;

function renderChip(canEdit: boolean) {
  return render(<MissingCommittedStartChip task={TASK} projectId="p-1" canEdit={canEdit} />);
}

describe('MissingCommittedStartChip', () => {
  beforeEach(() => {
    mutate.mockClear();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it('renders the chip as a button with the #2312 accessible name, testid, and label', () => {
    renderChip(true);
    const chip = screen.getByTestId('missing-dates-chip');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
    expect(chip).toHaveAccessibleName(
      'No committed start date — dates shown are auto-calculated, not committed.',
    );
    expect(screen.getByText('no committed start')).toBeInTheDocument();
    // Closed by default — no dialog rendered.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a warning dialog with both remediations for an editor', async () => {
    const user = userEvent.setup();
    renderChip(true);
    await user.click(screen.getByTestId('missing-dates-chip'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('No committed start');
    expect(screen.getByRole('button', { name: /set committed start/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to To Do' })).toBeInTheDocument();
  });

  it('Set committed start dispatches planned_start = task.start', async () => {
    const user = userEvent.setup();
    renderChip(true);
    await user.click(screen.getByTestId('missing-dates-chip'));
    await user.click(await screen.findByRole('button', { name: /set committed start/i }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({ planned_start: '2026-04-05' });
  });

  it('Move to To Do dispatches status = NOT_STARTED', async () => {
    const user = userEvent.setup();
    renderChip(true);
    await user.click(screen.getByTestId('missing-dates-chip'));
    await user.click(await screen.findByRole('button', { name: 'Move to To Do' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({ status: 'NOT_STARTED' });
  });

  it('shows the explanation but NO action buttons for a non-editor (rules 156/272)', async () => {
    const user = userEvent.setup();
    renderChip(false);
    await user.click(screen.getByTestId('missing-dates-chip'));
    await screen.findByRole('dialog');
    expect(screen.getByText(/auto-calculated by the scheduler/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set committed start/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move to To Do' })).not.toBeInTheDocument();
  });

  it('Escape closes the dialog and does not dispatch a write', async () => {
    const user = userEvent.setup();
    renderChip(true);
    await user.click(screen.getByTestId('missing-dates-chip'));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mutate).not.toHaveBeenCalled();
  });

  it('surfaces an offline error and keeps the dialog open (rule 29)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const user = userEvent.setup();
    renderChip(true);
    await user.click(screen.getByTestId('missing-dates-chip'));
    await user.click(await screen.findByRole('button', { name: /set committed start/i }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/offline/i);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
