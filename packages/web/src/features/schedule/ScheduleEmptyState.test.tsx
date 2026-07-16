import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ScheduleEmptyState } from './ScheduleView';

describe('ScheduleEmptyState (#2044)', () => {
  it('renders a discoverable "+ Add task" CTA and fires the handler', () => {
    const onAddTask = vi.fn();
    render(<ScheduleEmptyState onAddTask={onAddTask} />);
    const button = screen.getByRole('button', { name: /add task/i });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(onAddTask).toHaveBeenCalledTimes(1);
  });

  it('omits the CTA for read-only roles (no onAddTask)', () => {
    render(<ScheduleEmptyState />);
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add task/i })).toBeNull();
  });
});
