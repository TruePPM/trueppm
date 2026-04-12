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

  it('renders a dialog with required form fields', () => {
    renderModal();
    expect(screen.getByRole('dialog', { name: /new project/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /name/i })).toBeInTheDocument();
    expect(screen.getByText(/start date/i)).toBeInTheDocument();
  });

  it('focuses the name input on mount', () => {
    renderModal();
    expect(screen.getByRole('textbox', { name: /name/i })).toHaveFocus();
  });

  it('calls onClose when backdrop is clicked', async () => {
    renderModal();
    await userEvent.click(screen.getByRole('button', { name: /close dialog/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when Escape is pressed', async () => {
    renderModal();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when Cancel button is clicked', async () => {
    renderModal();
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('submit button is disabled when name is empty', () => {
    renderModal();
    expect(screen.getByRole('button', { name: /create project/i })).toBeDisabled();
  });

  it('submits with trimmed name and start date', async () => {
    renderModal();
    const nameInput = screen.getByRole('textbox', { name: /name/i });
    await userEvent.type(nameInput, '  Alpha  ');
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));

    expect(mutateMock).toHaveBeenCalledOnce();
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Alpha' }),
      expect.anything(),
    );
    const payload = mutateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload.description).toBeUndefined();
  });

  it('submits description when provided', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('textbox', { name: /name/i }), 'Beta');
    await userEvent.type(screen.getByPlaceholderText(/optional/i), 'A description');
    await userEvent.click(screen.getByRole('button', { name: /create project/i }));

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Beta', description: 'A description' }),
      expect.anything(),
    );
  });

  it('does not submit when name is whitespace only', async () => {
    renderModal();
    await userEvent.type(screen.getByRole('textbox', { name: /name/i }), '   ');
    expect(screen.getByRole('button', { name: /create project/i })).toBeDisabled();
  });

  it('shows error message when mutation fails', () => {
    mockMutation.isError = true;
    renderModal();
    expect(screen.getByRole('alert')).toHaveTextContent(/failed to create project/i);
  });

  it('shows creating state when mutation is pending', () => {
    mockMutation.isPending = true;
    renderModal();
    expect(screen.getByRole('button', { name: /creating/i })).toBeInTheDocument();
  });

  it('traps focus with Tab cycling — last to first', async () => {
    renderModal();
    await userEvent.type(screen.getByPlaceholderText('My Project'), 'Test');
    const dialog = screen.getByRole('dialog');
    const submitBtn = within(dialog).getByRole('button', { name: /create project/i });
    submitBtn.focus();

    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByPlaceholderText('My Project'));
  });

  it('traps focus with Shift+Tab cycling — first to last', async () => {
    renderModal();
    await userEvent.type(screen.getByPlaceholderText('My Project'), 'Test');
    const dialog = screen.getByRole('dialog');
    const nameInput = screen.getByPlaceholderText('My Project');
    nameInput.focus();

    await userEvent.tab({ shift: true });
    const submitBtn = within(dialog).getByRole('button', { name: /create project/i });
    expect(document.activeElement).toBe(submitBtn);
  });
});
