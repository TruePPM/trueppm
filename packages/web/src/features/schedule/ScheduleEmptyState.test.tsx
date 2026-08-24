import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ScheduleEmptyState } from './ScheduleView';

describe('ScheduleEmptyState (#2044)', () => {
  it('renders a discoverable "+ Add item" CTA and fires the handler', () => {
    const onAddTask = vi.fn();
    render(<ScheduleEmptyState onAddTask={onAddTask} />);
    const button = screen.getByRole('button', { name: /add item/i });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(onAddTask).toHaveBeenCalledTimes(1);
  });

  it('omits the CTA for read-only roles (no onAddTask)', () => {
    render(<ScheduleEmptyState />);
    expect(screen.getByText(/no items yet/i)).toBeInTheDocument();
    // The description sentence carries the word too, and no other spec reads it.
    expect(screen.getByText(/^Add items to lay out your schedule/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add item/i })).toBeNull();
  });
});
