import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GuardrailNotice } from './GuardrailNotice';
import type { GuardrailWarning } from '@/hooks/useTaskMutations';

const WARNINGS: GuardrailWarning[] = [
  { rule: 'phase_in_sprint', detail: 'Phases group work; assign the tasks inside it to the sprint instead.' },
];

describe('GuardrailNotice', () => {
  it('renders nothing when there are no warnings', () => {
    const { container } = render(
      <GuardrailNotice warnings={[]} onUndo={vi.fn()} onKeep={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('uses role=status (non-blocking), not alert', () => {
    render(<GuardrailNotice warnings={WARNINGS} onUndo={vi.fn()} onKeep={vi.fn()} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the outcome-language detail', () => {
    render(<GuardrailNotice warnings={WARNINGS} onUndo={vi.fn()} onKeep={vi.fn()} />);
    expect(screen.getByText(/Phases group work/)).toBeInTheDocument();
  });

  it('calls onKeep with empty reason when kept without a note (one-tap)', () => {
    const onKeep = vi.fn();
    render(<GuardrailNotice warnings={WARNINGS} onUndo={vi.fn()} onKeep={onKeep} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep it here' }));
    expect(onKeep).toHaveBeenCalledWith('');
  });

  it('calls onUndo when Undo is clicked', () => {
    const onUndo = vi.fn();
    render(<GuardrailNotice warnings={WARNINGS} onUndo={onUndo} onKeep={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it('reason field is optional and reveals on tap, then flows to onKeep', () => {
    const onKeep = vi.fn();
    render(<GuardrailNotice warnings={WARNINGS} onUndo={vi.fn()} onKeep={onKeep} />);
    // Not shown until requested.
    expect(screen.queryByLabelText(/Override note/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add a note/i }));
    fireEvent.change(screen.getByLabelText(/Override note/i), { target: { value: 'intentional' } });
    fireEvent.click(screen.getByRole('button', { name: 'Keep it here' }));
    expect(onKeep).toHaveBeenCalledWith('intentional');
  });
});
