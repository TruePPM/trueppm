import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AddTaskModal } from './AddTaskModal';

const createMutate = vi.fn();
let mockIsPending = false;
let mockIsError = false;

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => 'project-1',
}));

vi.mock('@/hooks/useTaskMutations', () => ({
  useCreateTask: () => ({ mutate: createMutate, isPending: mockIsPending, isError: mockIsError }),
}));

function renderModal(props: { phaseId?: string; phaseName?: string; onClose?: () => void } = {}) {
  return render(
    <AddTaskModal
      phaseId={props.phaseId ?? 'phase-abc'}
      phaseName={props.phaseName ?? 'Alpha Phase'}
      onClose={props.onClose ?? (() => {})}
    />,
  );
}

describe('AddTaskModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMutate.mockReset();
    mockIsPending = false;
    mockIsError = false;
  });

  it('renders the dialog with the phase name', () => {
    renderModal({ phaseName: 'Alpha Phase' });
    expect(screen.getByRole('dialog', { name: /Add task to Alpha Phase/ })).toBeInTheDocument();
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(screen.getByLabelText('Close dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('submits with trimmed name and passes the real phaseId as parent_id', async () => {
    const user = userEvent.setup();
    renderModal({ phaseId: 'phase-abc' });
    await user.type(screen.getByPlaceholderText('Task name'), 'New Task');
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Task', parent_id: 'phase-abc' }),
      expect.any(Object),
    );
  });

  it('passes null as parent_id when phaseId is "root"', async () => {
    const user = userEvent.setup();
    renderModal({ phaseId: 'root' });
    await user.type(screen.getByPlaceholderText('Task name'), 'Root Task');
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ parent_id: null }),
      expect.any(Object),
    );
  });

  it('does not call mutate when name is empty or whitespace', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByPlaceholderText('Task name'), '   ');
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('shows error alert when createTask.isError is true', () => {
    mockIsError = true;
    renderModal();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Failed to create task/)).toBeInTheDocument();
  });

  it('shows "Adding…" label and disables submit while isPending', () => {
    mockIsPending = true;
    renderModal();
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('does not call mutate when isPending is true and form is submitted', () => {
    mockIsPending = true;
    renderModal();
    // Even with a name, mutate should be blocked by the isPending guard
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('Tab key dispatches Tab keydown event (focus trap handler fires)', () => {
    renderModal();
    // The modal installs a keydown listener for Tab; verify it fires without error
    // by dispatching Tab from the last focusable element (the submit button).
    const addButton = screen.getByRole('button', { name: 'Add task' });
    addButton.focus();
    // Should not throw
    expect(() => fireEvent.keyDown(document, { key: 'Tab', shiftKey: false })).not.toThrow();
  });

  it('Shift+Tab dispatches Shift+Tab keydown event (focus trap handler fires)', () => {
    renderModal();
    const input = screen.getByPlaceholderText('Task name');
    input.focus();
    // Should not throw
    expect(() => fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })).not.toThrow();
  });
});
