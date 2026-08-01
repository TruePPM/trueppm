import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { ProgressAutoStatusConfirmDialog } from './ProgressAutoStatusConfirmDialog';

describe('ProgressAutoStatusConfirmDialog (#2639)', () => {
  it('names Complete and offers a Mark Complete action for the COMPLETE target', () => {
    renderWithProviders(
      <ProgressAutoStatusConfirmDialog targetStatus="COMPLETE" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/Mark task Complete\?/i)).toBeInTheDocument();
    expect(screen.getByText(/actual finish date/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark Complete/i })).toBeInTheDocument();
  });

  it('names Review and offers a Send to Review action for the REVIEW target', () => {
    renderWithProviders(
      <ProgressAutoStatusConfirmDialog targetStatus="REVIEW" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/Send task to Review\?/i)).toBeInTheDocument();
    expect(screen.getByText(/pending PM\/PMO sign-off/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send to Review/i })).toBeInTheDocument();
  });

  it('calls onConfirm when the primary action is clicked', () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <ProgressAutoStatusConfirmDialog targetStatus="COMPLETE" onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Mark Complete/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <ProgressAutoStatusConfirmDialog targetStatus="REVIEW" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel on Escape keydown', () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <ProgressAutoStatusConfirmDialog targetStatus="REVIEW" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
