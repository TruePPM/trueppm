import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DialogFooter } from './DialogFooter';

describe('DialogFooter', () => {
  it('renders Save (primary) + Cancel and the default status label', () => {
    render(<DialogFooter onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('disables Save until the form is dirty', () => {
    const { rerender } = render(<DialogFooter onSave={vi.fn()} onCancel={vi.fn()} dirty={false} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    rerender(<DialogFooter onSave={vi.fn()} onCancel={vi.fn()} dirty />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('invokes onSave / onCancel on click', async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<DialogFooter onSave={onSave} onCancel={onCancel} dirty />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('shows the saving label and disables Save while saving; Cancel stays enabled', () => {
    render(<DialogFooter onSave={vi.fn()} onCancel={vi.fn()} dirty saving />);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('renders a blocking validation message as an alert and disables Save', () => {
    render(
      <DialogFooter
        onSave={vi.fn()}
        onCancel={vi.fn()}
        dirty
        saveDisabled
        validationMessage="Name is required"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('renders a save error as a separate alert', () => {
    render(<DialogFooter onSave={vi.fn()} onCancel={vi.fn()} dirty error="Save failed" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Save failed');
  });
});
