import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateInputPopover } from './DateInputPopover';
import type { Task } from '@/types';

const TASK: Task = {
  id: 't1',
  wbs: '1',
  name: 'Design phase',
  start: '2025-03-17',
  finish: '2025-03-28',
  duration: 10,
  progress: 0,
  parentId: null,
  isCritical: false,
  isComplete: false,
  isSummary: false,
  isMilestone: false,
  status: 'NOT_STARTED',
  assignees: [],
  notes: '',
};

describe('DateInputPopover', () => {
  it('renders nothing when task is null', () => {
    const { container } = render(
      <DateInputPopover task={null} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the dialog with the task name when task is provided', () => {
    render(
      <DateInputPopover task={TASK} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Design phase/)).toBeInTheDocument();
  });

  it('pre-fills the start date input with the task start', () => {
    render(
      <DateInputPopover task={TASK} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    const input = screen.getByLabelText<HTMLInputElement>('Start date');
    expect(input.value).toBe('2025-03-17');
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(
      <DateInputPopover task={TASK} onConfirm={vi.fn()} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onConfirm with the start value when Confirm is clicked', () => {
    const onConfirm = vi.fn();
    render(
      <DateInputPopover task={TASK} onConfirm={onConfirm} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith('2025-03-17');
  });

  it('calls onConfirm with the updated start when date is changed', () => {
    const onConfirm = vi.fn();
    render(
      <DateInputPopover task={TASK} onConfirm={onConfirm} onClose={vi.fn()} />,
    );
    const input = screen.getByLabelText('Start date');
    fireEvent.change(input, { target: { value: '2025-03-24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith('2025-03-24');
  });

  it('calls onClose when the backdrop button is clicked', () => {
    const onClose = vi.fn();
    render(
      <DateInputPopover task={TASK} onConfirm={vi.fn()} onClose={onClose} />,
    );
    // The backdrop is now a button with aria-label "Close dialog"
    fireEvent.click(screen.getByLabelText('Close dialog'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
