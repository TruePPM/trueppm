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

  it('shell v2 offers Import plan and Add phase beside the primary action (#5106)', () => {
    const onImport = vi.fn();
    const onAddPhase = vi.fn();
    render(<ScheduleEmptyState onAddTask={vi.fn()} onImport={onImport} onAddPhase={onAddPhase} />);
    fireEvent.click(screen.getByRole('button', { name: 'Import plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add phase' }));
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onAddPhase).toHaveBeenCalledTimes(1);
  });

  it('v1 shows neither extra button', () => {
    render(<ScheduleEmptyState onAddTask={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Import plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add phase' })).toBeNull();
  });
});
