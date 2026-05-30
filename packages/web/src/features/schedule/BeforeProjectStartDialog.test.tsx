import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { BeforeProjectStartDialog } from './BeforeProjectStartDialog';

const baseProps = {
  projectStartDate: '2026-04-01',
  effectiveFloorDate: '2026-04-01', // working day → equals the literal start
  attemptedStart: '2026-03-15',
  canMoveStart: true,
  error: null,
  isPending: false,
  onSnap: vi.fn(),
  onMoveStart: vi.fn(),
  onCancel: vi.fn(),
};

describe('BeforeProjectStartDialog', () => {
  it('renders the floor explanation with the formatted project start date', () => {
    renderWithProviders(<BeforeProjectStartDialog {...baseProps} />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/Schedule before the project start\?/i)).toBeInTheDocument();
    expect(screen.getByText(/Apr 1, 2026/)).toBeInTheDocument();
  });

  it('shows Move project start only when the user may move it', () => {
    const { rerender } = renderWithProviders(<BeforeProjectStartDialog {...baseProps} />);
    expect(screen.getByRole('button', { name: /Move project start/i })).toBeInTheDocument();
    rerender(<BeforeProjectStartDialog {...baseProps} canMoveStart={false} />);
    expect(screen.queryByRole('button', { name: /Move project start/i })).not.toBeInTheDocument();
    // Snap + Cancel remain for lower roles.
    expect(screen.getByRole('button', { name: /Snap to project start/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
  });

  it('wires the three actions to their handlers', () => {
    const onSnap = vi.fn();
    const onMoveStart = vi.fn();
    const onCancel = vi.fn();
    renderWithProviders(
      <BeforeProjectStartDialog
        {...baseProps}
        onSnap={onSnap}
        onMoveStart={onMoveStart}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Snap to project start/i }));
    fireEvent.click(screen.getByRole('button', { name: /Move project start/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(onSnap).toHaveBeenCalledOnce();
    expect(onMoveStart).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('renders an inline error when a mutation fails', () => {
    renderWithProviders(
      <BeforeProjectStartDialog {...baseProps} error="You may not have permission." />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/may not have permission/i);
  });

  it('disables the actions while pending', () => {
    renderWithProviders(<BeforeProjectStartDialog {...baseProps} isPending />);
    expect(screen.getByRole('button', { name: /Snap to project start/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Move project start/i })).toBeDisabled();
  });

  it('calls onCancel on Escape', () => {
    const onCancel = vi.fn();
    renderWithProviders(<BeforeProjectStartDialog {...baseProps} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('names the working-day floor when the project start is a non-working day (#884)', () => {
    // Sat May 30 2026 → floor Mon Jun 1 2026: the header keeps the literal start
    // but the copy must surface the working-day floor as the snap target.
    renderWithProviders(
      <BeforeProjectStartDialog
        {...baseProps}
        projectStartDate="2026-05-30"
        effectiveFloorDate="2026-06-01"
      />,
    );
    expect(screen.getByText(/May 30, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/non-working day/i)).toBeInTheDocument();
    // The floor date appears in the floor span and the snap copy; assert the
    // dialog body contains it (text is split across nodes by the <span> wrap).
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Jun 1, 2026');
  });

  it('does not mention a separate floor when the start is already a working day', () => {
    renderWithProviders(<BeforeProjectStartDialog {...baseProps} />);
    expect(screen.queryByText(/non-working day/i)).not.toBeInTheDocument();
  });
});
