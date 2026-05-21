import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDiscardDialog } from './ConfirmDiscardDialog';

describe('<ConfirmDiscardDialog>', () => {
  it('renders an alertdialog with the right copy', () => {
    render(<ConfirmDiscardDialog onKeepEditing={vi.fn()} onDiscard={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-labelledby', 'discard-changes-title');
    expect(dialog).toHaveAttribute('aria-describedby', 'discard-changes-body');
    expect(screen.getByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(
      screen.getByText(/Your changes on this page haven't been saved yet/i),
    ).toBeInTheDocument();
  });

  it('focuses "Keep editing" on mount — never autofocuses the destructive path', () => {
    render(<ConfirmDiscardDialog onKeepEditing={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
  });

  it('invokes onKeepEditing when Escape is pressed', () => {
    const onKeepEditing = vi.fn();
    render(<ConfirmDiscardDialog onKeepEditing={onKeepEditing} onDiscard={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onKeepEditing).toHaveBeenCalledTimes(1);
  });

  it('invokes onKeepEditing when the backdrop is clicked', () => {
    const onKeepEditing = vi.fn();
    render(<ConfirmDiscardDialog onKeepEditing={onKeepEditing} onDiscard={vi.fn()} />);
    const backdrop = screen.getByRole('alertdialog');
    fireEvent.pointerDown(backdrop, { target: backdrop });
    expect(onKeepEditing).toHaveBeenCalledTimes(1);
  });

  it('invokes onDiscard when "Discard changes" is clicked', () => {
    const onDiscard = vi.fn();
    render(<ConfirmDiscardDialog onKeepEditing={vi.fn()} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('invokes onKeepEditing when "Keep editing" is clicked', () => {
    const onKeepEditing = vi.fn();
    render(<ConfirmDiscardDialog onKeepEditing={onKeepEditing} onDiscard={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(onKeepEditing).toHaveBeenCalledTimes(1);
  });
});
