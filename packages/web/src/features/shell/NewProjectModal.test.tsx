import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { NewProjectModal } from './NewProjectModal';

const mutateMock = vi.fn();
const mockMutation = {
  mutate: mutateMock,
  isPending: false,
  isError: false,
};

vi.mock('@/hooks/useProjectMutations', () => ({
  useCreateProject: () => mockMutation,
}));

// Source projects offered by the "Copy settings from" picker (#1659). Mocked so
// the option list is deterministic without a live /projects/ fetch.
const projectsResult = {
  data: [
    { id: 'proj-alpha', name: 'Alpha' },
    { id: 'proj-beta', name: 'Beta' },
  ] as Array<{ id: string; name: string }>,
  isLoading: false,
  error: null,
};
vi.mock('@/hooks/useProjects', () => ({
  useProjects: () => projectsResult,
}));

describe('NewProjectModal', () => {
  const onClose = vi.fn();
  const onCreated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mutateMock.mockReset();
    mockMutation.isPending = false;
    mockMutation.isError = false;
  });

  function renderModal() {
    return renderWithProviders(<NewProjectModal onClose={onClose} onCreated={onCreated} />);
  }

  // Helpers to navigate the wizard steps.
  async function goToStep2(name = 'My Project') {
    await userEvent.type(screen.getByRole('textbox', { name: /name/i }), name);
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
  }

  async function goToStep3(name = 'My Project') {
    await goToStep2(name);
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
  }

  // ---------------------------------------------------------------------------
  // Step 1 — Project details
  // ---------------------------------------------------------------------------

  it('renders a dialog with step 1 fields on open', () => {
    renderModal();
    expect(screen.getByRole('dialog', { name: /new project/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /name/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/optional/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
    expect(screen.queryByText(/start date/i)).not.toBeInTheDocument();
  });

  it('focuses the name input on mount', () => {
    renderModal();
    expect(screen.getByRole('textbox', { name: /name/i })).toHaveFocus();
  });

  it('Next button is disabled when name is empty', () => {
    renderModal();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });

  it('Next button is disabled when name is whitespace only', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('textbox', { name: /name/i }), '   ');
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });

  it('Next button is enabled once a name is entered', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('textbox', { name: /name/i }), 'Alpha');
    expect(screen.getByRole('button', { name: /next/i })).not.toBeDisabled();
  });

  it('advances to step 2 when Next is clicked', async () => {
    renderModal();
    await goToStep2();
    expect(screen.getByText(/start date/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
  });

  it('calls onClose when Cancel is clicked on step 1', async () => {
    renderModal();
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when Escape is pressed', async () => {
    renderModal();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when backdrop is clicked', async () => {
    renderModal();
    await userEvent.click(screen.getByRole('button', { name: /close dialog/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------------
  // Step 2 — Schedule
  // ---------------------------------------------------------------------------

  it('shows Back button on step 2 that returns to step 1', async () => {
    renderModal();
    await goToStep2();
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByRole('textbox', { name: /name/i })).toBeInTheDocument();
  });

  it('Next on step 2 advances to step 3', async () => {
    renderModal();
    await goToStep3();
    expect(screen.getByRole('radiogroup', { name: /project methodology/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create project/i })).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Step 3 — Methodology (ADR-0041)
  // ---------------------------------------------------------------------------

  it('Hybrid methodology is pre-selected by default', async () => {
    renderModal();
    await goToStep3();
    const radiogroup = screen.getByRole('radiogroup', { name: /project methodology/i });
    const hybrid = within(radiogroup).getByRole('radio', { name: /hybrid/i });
    expect(hybrid).toHaveAttribute('aria-checked', 'true');
    // Waterfall and Agile remain selectable.
    const waterfall = within(radiogroup).getByRole('radio', { name: /waterfall/i });
    const agile = within(radiogroup).getByRole('radio', { name: /agile/i });
    expect(waterfall).not.toBeDisabled();
    expect(agile).not.toBeDisabled();
  });

  it('Selecting Agile changes the aria-checked state', async () => {
    renderModal();
    await goToStep3();
    const radiogroup = screen.getByRole('radiogroup', { name: /project methodology/i });
    const agile = within(radiogroup).getByRole('radio', { name: /agile/i });
    await userEvent.click(agile);
    expect(agile).toHaveAttribute('aria-checked', 'true');
  });

  it('submits selected methodology in the create payload', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('textbox', { name: /name/i }), 'Waterfall Project');
    await userEvent.click(screen.getByRole('button', { name: /next/i })); // step 1 → 2
    await userEvent.click(screen.getByRole('button', { name: /next/i })); // step 2 → 3
    const radiogroup = screen.getByRole('radiogroup', { name: /project methodology/i });
    await userEvent.click(within(radiogroup).getByRole('radio', { name: /waterfall/i }));
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Waterfall Project', methodology: 'WATERFALL' }),
      expect.anything(),
    );
  });

  it('Create project button is enabled by default on step 3', async () => {
    renderModal();
    await goToStep3();
    expect(screen.getByRole('button', { name: /create project/i })).not.toBeDisabled();
  });

  it('submits with trimmed name and start date', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('textbox', { name: /name/i }), '  Alpha  ');
    await userEvent.click(screen.getByRole('button', { name: /next/i })); // step 1 → 2
    await userEvent.click(screen.getByRole('button', { name: /next/i })); // step 2 → 3
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));

    expect(mutateMock).toHaveBeenCalledOnce();
    const payload = mutateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.name).toBe('Alpha');
    expect(payload.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.description).toBeUndefined();
  });

  it('submits description when provided', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('textbox', { name: /name/i }), 'Beta');
    await userEvent.type(screen.getByPlaceholderText(/optional/i), 'A description');
    await userEvent.click(screen.getByRole('button', { name: /next/i })); // step 1 → 2
    await userEvent.click(screen.getByRole('button', { name: /next/i })); // step 2 → 3
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Beta', description: 'A description' }),
      expect.anything(),
    );
  });

  it('shows error message on step 3 when mutation fails', async () => {
    mockMutation.isError = true;
    renderModal();
    await goToStep3();
    expect(screen.getByRole('alert')).toHaveTextContent(/failed to create project/i);
  });

  it('shows creating state when mutation is pending', async () => {
    mockMutation.isPending = true;
    renderModal();
    await goToStep3();
    expect(screen.getByRole('button', { name: /creating/i })).toBeInTheDocument();
  });

  it('Back on step 3 returns to step 2', async () => {
    renderModal();
    await goToStep3();
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByText(/start date/i)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Copy settings from another project (#1659, ADR-0242)
  // ---------------------------------------------------------------------------

  it('renders the copy-settings picker on step 3 with a None option and the readable projects', async () => {
    renderModal();
    await goToStep3();
    const picker = screen.getByRole('combobox', { name: /copy settings from/i });
    expect(picker).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: /none/i })).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: 'Alpha' })).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: 'Beta' })).toBeInTheDocument();
  });

  it('omits copy_settings_from from the payload when no source project is picked', async () => {
    renderModal();
    await goToStep3();
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));

    const payload = mutateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('copy_settings_from');
  });

  it('includes copy_settings_from in the payload when a source project is picked', async () => {
    renderModal();
    await goToStep3();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /copy settings from/i }),
      'proj-beta',
    );
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ copy_settings_from: 'proj-beta' }),
      expect.anything(),
    );
  });

  // ---------------------------------------------------------------------------
  // Default role for new members (ADR-0363, #157)
  // ---------------------------------------------------------------------------

  it('sends default_member_role = Team Member (100) by default', async () => {
    renderModal();
    await goToStep3();
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ default_member_role: 100 }),
      expect.anything(),
    );
  });

  it('sends the chosen default_member_role when changed', async () => {
    renderModal();
    await goToStep3();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /default role for new members/i }),
      'Project Manager',
    );
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ default_member_role: 300 }),
      expect.anything(),
    );
  });

  // ---------------------------------------------------------------------------
  // Focus trap
  // ---------------------------------------------------------------------------

  it('traps focus with Tab cycling — last to first on step 1', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('textbox', { name: /name/i }), 'Test');
    const nextBtn = screen.getByRole('button', { name: /next/i });
    nextBtn.focus();

    await userEvent.tab();
    // After Tab from last focusable, focus wraps to first focusable (close backdrop or name input).
    // getFocusable includes the backdrop button first, then dialog focusables.
    // The name input is first inside the dialog; backdrop close button is the overall first.
    expect(document.activeElement).not.toBe(nextBtn);
  });

  it('traps focus with Shift+Tab cycling — first to last on step 1', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('textbox', { name: /name/i }), 'Test');
    // We can only trap focus within the dialog (dialogRef). The backdrop is outside.
    const nameInput = screen.getByRole('textbox', { name: /name/i });
    nameInput.focus();

    await userEvent.tab({ shift: true });
    // Focus should cycle to the last element in the dialog (Next button).
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /next/i }));
  });

  // ---------------------------------------------------------------------------
  // Enter-key navigation
  // ---------------------------------------------------------------------------

  it('pressing Enter in name field advances to step 2', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('textbox', { name: /name/i }), 'Gamma');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText(/start date/i)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // ADR-0070 — Program prefill on create
  // ---------------------------------------------------------------------------

  it('omits program from the create payload when programId is not provided', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('textbox', { name: /name/i }), 'Standalone');
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));

    const payload = mutateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('program');
  });

  it('passes program in the create payload when programId is provided', async () => {
    renderWithProviders(
      <NewProjectModal
        onClose={onClose}
        onCreated={onCreated}
        programId="program-uuid-123"
      />,
    );
    await userEvent.type(screen.getByRole('textbox', { name: /name/i }), 'In-Program');
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'In-Program', program: 'program-uuid-123' }),
      expect.anything(),
    );
  });
});
