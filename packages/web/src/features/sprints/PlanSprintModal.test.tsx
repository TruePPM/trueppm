import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { localTodayIso } from '@/lib/localDate';
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
  // Issue #1913 — dismiss-guard (web-rule 217) on Escape / scrim / Cancel
  // -------------------------------------------------------------------------

  describe('dismiss-guard (#1913)', () => {
    it('Escape with a dirty form opens the discard prompt instead of closing', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<PlanSprintModal projectId="proj-1" onClose={onClose} />);

      await user.type(screen.getByRole('textbox', { name: /Name/i }), 'Sprint 14');
      await user.keyboard('{Escape}');

      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveTextContent('Discard unsaved changes?');
      expect(onClose).not.toHaveBeenCalled();
    });

    it('Keep editing dismisses the prompt and leaves the form open', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<PlanSprintModal projectId="proj-1" onClose={onClose} />);

      await user.type(screen.getByRole('textbox', { name: /Name/i }), 'Sprint 14');
      await user.keyboard('{Escape}');
      await user.click(screen.getByRole('button', { name: 'Keep editing' }));

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox', { name: /Name/i })).toHaveValue('Sprint 14');
    });

    it('Discard changes closes the modal', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<PlanSprintModal projectId="proj-1" onClose={onClose} />);

      await user.type(screen.getByRole('textbox', { name: /Name/i }), 'Sprint 14');
      await user.keyboard('{Escape}');
      await user.click(screen.getByRole('button', { name: 'Discard changes' }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('scrim-click with a dirty form opens the discard prompt instead of closing', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<PlanSprintModal projectId="proj-1" onClose={onClose} />);

      await user.type(screen.getByRole('textbox', { name: /Name/i }), 'Sprint 14');
      await user.click(screen.getByRole('button', { name: 'Close dialog' }));

      expect(screen.getByRole('alertdialog')).toHaveTextContent('Discard unsaved changes?');
      expect(onClose).not.toHaveBeenCalled();
    });

    it('Cancel with a dirty form opens the discard prompt instead of closing', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(<PlanSprintModal projectId="proj-1" onClose={onClose} />);

      await user.type(screen.getByRole('textbox', { name: /Name/i }), 'Sprint 14');
      await user.click(screen.getByRole('button', { name: /^Cancel$/i }));

      expect(screen.getByRole('alertdialog')).toHaveTextContent('Discard unsaved changes?');
      expect(onClose).not.toHaveBeenCalled();
    });
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

    it('prefers the existing sprint window over a supplied defaultStart', () => {
      renderWithProviders(
        <PlanSprintModal
          projectId="proj-1"
          defaultStart="2026-01-05"
          existingSprint={existing}
          onClose={() => undefined}
        />,
      );
      expect(screen.getByLabelText(/^Start/i)).toHaveValue('2026-05-01');
      expect(screen.getByLabelText(/^Finish/i)).toHaveValue('2026-05-14');
    });

    it('leaves the goal blank when the existing sprint has none', () => {
      renderWithProviders(
        <PlanSprintModal
          projectId="proj-1"
          existingSprint={{
            id: 'sp-nogoal',
            name: 'Sprint Foxtrot',
            start_date: '2026-06-01',
            finish_date: '2026-06-14',
          }}
          onClose={() => undefined}
        />,
      );
      expect(screen.getByRole('textbox', { name: /Goal/i })).toHaveValue('');
    });

    it('calls onUpdated with the saved sprint id', async () => {
      const onClose = vi.fn();
      const onUpdated = vi.fn();
      updateMutateMock.mockImplementation(
        (_vars: unknown, opts?: { onSuccess?: (data: { id: string }) => void }) =>
          opts?.onSuccess?.({ id: 'sp-edit' }),
      );
      renderWithProviders(
        <PlanSprintModal
          projectId="proj-1"
          existingSprint={existing}
          onClose={onClose}
          onUpdated={onUpdated}
        />,
      );
      await userEvent.type(screen.getByRole('textbox', { name: /Name/i }), '!');
      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(onUpdated).toHaveBeenCalledWith('sp-edit');
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('still closes after a successful edit when no onUpdated is supplied', async () => {
      const onClose = vi.fn();
      updateMutateMock.mockImplementation(
        (_vars: unknown, opts?: { onSuccess?: (data: { id: string }) => void }) =>
          opts?.onSuccess?.({ id: 'sp-edit' }),
      );
      renderWithProviders(
        <PlanSprintModal projectId="proj-1" existingSprint={existing} onClose={onClose} />,
      );
      await userEvent.type(screen.getByRole('textbox', { name: /Name/i }), '!');
      await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      expect(onClose).toHaveBeenCalledOnce();
    });

    it('shows the update-specific error message when the PATCH fails', () => {
      mockUpdateMutation.isError = true;
      renderWithProviders(
        <PlanSprintModal
          projectId="proj-1"
          existingSprint={existing}
          onClose={() => undefined}
        />,
      );
      expect(screen.getByRole('alert')).toHaveTextContent(/Failed to update sprint/i);
      expect(screen.queryByText(/Failed to create/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Defaults, validation guards and submit gating
  // -------------------------------------------------------------------------

  it("seeds the start date with today's local calendar day when no default is given", () => {
    renderWithProviders(<PlanSprintModal projectId="proj-1" onClose={() => undefined} />);
    expect(screen.getByLabelText(/^Start/i)).toHaveValue(localTodayIso());
  });

  it('suppresses the range alert while a date field is empty', async () => {
    renderWithProviders(
      <PlanSprintModal projectId="proj-1" defaultStart="2026-04-01" onClose={() => undefined} />,
    );
    await userEvent.type(screen.getByRole('textbox', { name: /Name/i }), 'Sprint X');
    await userEvent.clear(screen.getByLabelText(/^Start/i));

    // Half-typed range is not an error yet — only a complete, inverted range is.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Plan sprint$/i })).toBeDisabled();
  });

  it('rejects a finish date equal to the start date', async () => {
    renderWithProviders(
      <PlanSprintModal projectId="proj-1" defaultStart="2026-04-01" onClose={() => undefined} />,
    );
    await userEvent.type(screen.getByRole('textbox', { name: /Name/i }), 'Sprint X');
    const finish = screen.getByLabelText(/^Finish/i);
    await userEvent.clear(finish);
    await userEvent.type(finish, '2026-04-01');

    expect(screen.getByRole('alert')).toHaveTextContent(/Finish date must be after start date/i);
    expect(screen.getByRole('button', { name: /^Plan sprint$/i })).toBeDisabled();
  });

  it('ignores a form submit while the form is invalid', () => {
    const { container } = renderWithProviders(
      <PlanSprintModal projectId="proj-1" defaultStart="2026-04-01" onClose={() => undefined} />,
    );
    const form = container.querySelector<HTMLFormElement>('form');
    if (!form) throw new Error('PlanSprintModal did not render a <form>');
    fireEvent.submit(form);
    expect(mutateMock).not.toHaveBeenCalled();
    expect(updateMutateMock).not.toHaveBeenCalled();
  });

  it('calls onCreated with the new sprint id', async () => {
    const onCreated = vi.fn();
    mutateMock.mockImplementation(
      (_payload: unknown, opts?: { onSuccess?: (data: { id: string }) => void }) =>
        opts?.onSuccess?.({ id: 'sp-new' }),
    );
    renderWithProviders(
      <PlanSprintModal
        projectId="proj-1"
        defaultStart="2026-04-01"
        onClose={() => undefined}
        onCreated={onCreated}
      />,
    );
    await userEvent.type(screen.getByRole('textbox', { name: /Name/i }), 'Sprint 13');
    await userEvent.click(screen.getByRole('button', { name: /^Plan sprint$/i }));

    expect(onCreated).toHaveBeenCalledWith('sp-new');
  });

  it('disables Cancel while the create is in flight', () => {
    mockMutation.isPending = true;
    renderWithProviders(<PlanSprintModal projectId="proj-1" onClose={() => undefined} />);
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // Focus management — trap cycle and restore-on-unmount
  // -------------------------------------------------------------------------

  describe('focus management', () => {
    async function renderWithName() {
      const result = renderWithProviders(
        <PlanSprintModal projectId="proj-1" defaultStart="2026-04-01" onClose={() => undefined} />,
      );
      // A non-empty name enables the submit button, which is the trap's LAST stop
      // (getFocusable skips `button[disabled]`).
      await userEvent.type(screen.getByRole('textbox', { name: /Name/i }), 'Sprint X');
      return result;
    }

    it('wraps Tab from the last control back to the first', async () => {
      await renderWithName();
      const submit = screen.getByRole('button', { name: /^Plan sprint$/i });
      submit.focus();

      fireEvent.keyDown(document, { key: 'Tab' });
      expect(screen.getByRole('textbox', { name: /Name/i })).toHaveFocus();
    });

    it('wraps Shift+Tab from the first control back to the last', async () => {
      await renderWithName();
      const name = screen.getByRole('textbox', { name: /Name/i });
      name.focus();

      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
      expect(screen.getByRole('button', { name: /^Plan sprint$/i })).toHaveFocus();
    });

    it('leaves Shift+Tab alone in the middle of the cycle', async () => {
      await renderWithName();
      const goal = screen.getByRole('textbox', { name: /Goal/i });
      goal.focus();

      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
      expect(goal).toHaveFocus();
    });

    it('leaves plain Tab alone in the middle of the cycle', async () => {
      await renderWithName();
      const name = screen.getByRole('textbox', { name: /Name/i });
      name.focus();

      fireEvent.keyDown(document, { key: 'Tab' });
      // Not the last stop, so the trap does not intervene — the browser's own
      // sequential navigation takes over.
      expect(name).toHaveFocus();
    });

    it('ignores keys other than Tab', async () => {
      await renderWithName();
      const submit = screen.getByRole('button', { name: /^Plan sprint$/i });
      submit.focus();

      fireEvent.keyDown(document, { key: 'ArrowDown' });
      expect(submit).toHaveFocus();
    });

    it('focuses the name field on open and restores the trigger on close', () => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      trigger.focus();

      const { unmount } = renderWithProviders(
        <PlanSprintModal projectId="proj-1" onClose={() => undefined} />,
      );
      expect(screen.getByRole('textbox', { name: /Name/i })).toHaveFocus();

      unmount();
      expect(trigger).toHaveFocus();
      trigger.remove();
    });

    it('does not try to restore focus to a non-HTML trigger', () => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('tabindex', '0');
      document.body.appendChild(svg);
      svg.focus();
      expect(document.activeElement).toBe(svg);

      const { unmount } = renderWithProviders(
        <PlanSprintModal projectId="proj-1" onClose={() => undefined} />,
      );
      unmount();

      // SVGElement is not an HTMLElement, so the restore is skipped rather than
      // throwing on a missing `focus`.
      expect(document.activeElement).not.toBe(svg);
      svg.remove();
    });
  });

  // -------------------------------------------------------------------------
  // Dirty detection covers every field the modal opened with (#1913)
  // -------------------------------------------------------------------------

  describe('dirty detection per field', () => {
    it('arms the guard when only the goal changed', async () => {
      const onClose = vi.fn();
      renderWithProviders(<PlanSprintModal projectId="proj-1" onClose={onClose} />);
      await userEvent.type(screen.getByRole('textbox', { name: /Goal/i }), 'Ship the pilot');
      await userEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

      expect(screen.getByRole('alertdialog')).toHaveTextContent('Discard unsaved changes?');
      expect(onClose).not.toHaveBeenCalled();
    });

    it('arms the guard when only the start date changed', async () => {
      const onClose = vi.fn();
      renderWithProviders(
        <PlanSprintModal projectId="proj-1" defaultStart="2026-04-01" onClose={onClose} />,
      );
      const start = screen.getByLabelText(/^Start/i);
      await userEvent.clear(start);
      await userEvent.type(start, '2026-04-02');
      await userEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

      expect(screen.getByRole('alertdialog')).toHaveTextContent('Discard unsaved changes?');
      expect(onClose).not.toHaveBeenCalled();
    });

    it('arms the guard when only the finish date changed', async () => {
      const onClose = vi.fn();
      renderWithProviders(
        <PlanSprintModal projectId="proj-1" defaultStart="2026-04-01" onClose={onClose} />,
      );
      const finish = screen.getByLabelText(/^Finish/i);
      await userEvent.clear(finish);
      await userEvent.type(finish, '2026-04-20');
      await userEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

      expect(screen.getByRole('alertdialog')).toHaveTextContent('Discard unsaved changes?');
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
