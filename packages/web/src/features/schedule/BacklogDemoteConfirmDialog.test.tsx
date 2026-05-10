import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { BacklogDemoteConfirmDialog } from './BacklogDemoteConfirmDialog';

describe('BacklogDemoteConfirmDialog', () => {
  it('renders the dialog with title and body', () => {
    renderWithProviders(
      <BacklogDemoteConfirmDialog onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/Move to Backlog\?/i)).toBeInTheDocument();
    expect(screen.getByText(/removes? the task from the active board/i)).toBeInTheDocument();
  });

  it('calls onConfirm when Move to Backlog button is clicked', () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <BacklogDemoteConfirmDialog onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Move to Backlog/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel when Cancel button is clicked', () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <BacklogDemoteConfirmDialog onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel on Escape keydown', () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <BacklogDemoteConfirmDialog onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
