import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { PlanSprintModal } from './PlanSprintModal';

const mutateMock = vi.fn();
const updateMutateMock = vi.fn();
const mockMutation = {
  mutate: mutateMock,
  isPending: false,
  isError: false,
};
const mockUpdateMutation = {
  mutate: updateMutateMock,
  isPending: false,
  isError: false,
};

vi.mock('@/hooks/useSprints', () => ({
  useSprintMutations: () => ({
    createSprint: mockMutation,
    closeSprint: { mutate: vi.fn(), isPending: false, isError: false },
    activateSprint: { mutate: vi.fn(), isPending: false, isError: false },
    updateSprint: mockUpdateMutation,
  }),
}));

beforeEach(() => {
  mutateMock.mockReset();
  updateMutateMock.mockReset();
  mockMutation.isPending = false;
  mockMutation.isError = false;
  mockUpdateMutation.isPending = false;
  mockUpdateMutation.isError = false;
});

describe('PlanSprintModal', () => {
  it('renders the dialog with the correct accessible name and required fields', () => {
    renderWithProviders(
      <PlanSprintModal projectId="proj-1" onClose={() => undefined} />,
    );
    expect(
      screen.getByRole('dialog', { name: /Plan next sprint/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Name/i })).toBeRequired();
    expect(screen.getByLabelText(/^Start/i)).toBeRequired();
    expect(screen.getByLabelText(/^Finish/i)).toBeRequired();
  });

  it('seeds finish-date 13 days after start (2-week iteration default)', () => {
    renderWithProviders(
      <PlanSprintModal
        projectId="proj-1"
        defaultStart="2026-04-01"
        onClose={() => undefined}
      />,
    );
    expect(screen.getByLabelText(/^Start/i)).toHaveValue('2026-04-01');
    expect(screen.getByLabelText(/^Finish/i)).toHaveValue('2026-04-14');
  });

  it('disables Plan sprint until name is non-empty', async () => {
    renderWithProviders(
      <PlanSprintModal projectId="proj-1" onClose={() => undefined} />,
    );
    const submit = screen.getByRole('button', { name: /Plan sprint/i });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: /Name/i }), 'Sprint X');
    expect(submit).not.toBeDisabled();
  });

  it('shows a validation alert when finish ≤ start', async () => {
    renderWithProviders(
      <PlanSprintModal
        projectId="proj-1"
        defaultStart="2026-04-10"
        onClose={() => undefined}
      />,
    );
    const finish = screen.getByLabelText(/^Finish/i);
    await userEvent.clear(finish);
    await userEvent.type(finish, '2026-04-05');
    expect(screen.getByRole('alert')).toHaveTextContent(/Finish date must be after start date/i);
  });

  it('submits the create payload with trimmed name and goal', async () => {
    const onClose = vi.fn();
    mutateMock.mockImplementation(
      (_payload: unknown, opts?: { onSuccess?: (data: { id: string }) => void }) =>
        opts?.onSuccess?.({ id: 'new-sprint-id' }),
    );
    renderWithProviders(
      <PlanSprintModal
        projectId="proj-1"
        defaultStart="2026-04-01"
        onClose={onClose}
      />,
    );
    await userEvent.type(screen.getByRole('textbox', { name: /Name/i }), '  Sprint 13  ');
    await userEvent.type(screen.getByRole('textbox', { name: /Goal/i }), '  Pilot deployment  ');
    await userEvent.click(screen.getByRole('button', { name: /Plan sprint/i }));

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Sprint 13',
        goal: 'Pilot deployment',
        start_date: '2026-04-01',
        finish_date: '2026-04-14',
      }),
      expect.anything(),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('omits goal from payload when blank', async () => {
    mutateMock.mockImplementation(
      (_payload: unknown, opts?: { onSuccess?: (data: { id: string }) => void }) =>
        opts?.onSuccess?.({ id: 'new-sprint-id' }),
    );
    renderWithProviders(
      <PlanSprintModal
        projectId="proj-1"
        defaultStart="2026-04-01"
        onClose={() => undefined}
      />,
    );
    await userEvent.type(screen.getByRole('textbox', { name: /Name/i }), 'Sprint 13');
    await userEvent.click(screen.getByRole('button', { name: /Plan sprint/i }));

    const payload = mutateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.goal).toBeUndefined();
  });

  it('shows the creating state while mutation is pending', () => {
    mockMutation.isPending = true;
    renderWithProviders(
      <PlanSprintModal projectId="proj-1" onClose={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: /Creating/i })).toBeInTheDocument();
  });

  it('shows error alert when mutation fails', () => {
    mockMutation.isError = true;
    renderWithProviders(
      <PlanSprintModal projectId="proj-1" onClose={() => undefined} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to create sprint/i);
  });

  it('closes when Cancel is clicked', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <PlanSprintModal projectId="proj-1" onClose={onClose} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <PlanSprintModal projectId="proj-1" onClose={onClose} />,
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Issue #299 — Edit mode
  // -------------------------------------------------------------------------

  describe('edit mode (#299)', () => {
    const existing = {
      id: 'sp-edit',
      name: 'Sprint Echo',
      goal: 'Telemetry retrofit',
      start_date: '2026-05-01',
      finish_date: '2026-05-14',
    };

    it('renders with the edit-mode title and prefilled fields', () => {
      renderWithProviders(
        <PlanSprintModal
          projectId="proj-1"
          existingSprint={existing}
          onClose={() => undefined}
        />,
      );
      expect(
        screen.getByRole('dialog', { name: /Edit planned sprint/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /Name/i })).toHaveValue('Sprint Echo');
      expect(screen.getByLabelText(/^Start/i)).toHaveValue('2026-05-01');
      expect(screen.getByLabelText(/^Finish/i)).toHaveValue('2026-05-14');
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    });

    it('submits via updateSprint with the edited values', async () => {
      const onClose = vi.fn();
      renderWithProviders(
        <PlanSprintModal
          projectId="proj-1"
          existingSprint={existing}
          onClose={onClose}
        />,
      );
      const name = screen.getByRole('textbox', { name: /Name/i });
      await userEvent.clear(name);
      await userEvent.type(name, 'Sprint Echo (renamed)');
      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      expect(updateMutateMock).toHaveBeenCalledTimes(1);
      const call = updateMutateMock.mock.calls[0][0] as {
        sprintId: string;
        payload: Record<string, unknown>;
      };
      expect(call.sprintId).toBe('sp-edit');
      expect(call.payload.name).toBe('Sprint Echo (renamed)');
      expect(call.payload.start_date).toBe('2026-05-01');
      expect(call.payload.finish_date).toBe('2026-05-14');
      // createSprint should NOT have been called.
      expect(mutateMock).not.toHaveBeenCalled();
    });

    it('CTA shows "Saving…" while the update is pending', () => {
      mockUpdateMutation.isPending = true;
      renderWithProviders(
        <PlanSprintModal
          projectId="proj-1"
          existingSprint={existing}
          onClose={() => undefined}
        />,
      );
      expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    });
  });
});
