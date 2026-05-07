import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScheduleAddMilestoneButton } from './ScheduleAddMilestoneButton';

describe('ScheduleAddMilestoneButton', () => {
  it('renders with the gold diamond glyph and label', () => {
    render(<ScheduleAddMilestoneButton onAddMilestone={vi.fn()} />);
    expect(screen.getByTestId('add-milestone-button')).toBeInTheDocument();
    expect(screen.getByText('+ Milestone')).toBeInTheDocument();
  });

  it('exposes a hotkey-aware accessible label', () => {
    render(<ScheduleAddMilestoneButton onAddMilestone={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Add new milestone (Cmd+M)' })).toBeInTheDocument();
  });

  it('clicking calls onAddMilestone', () => {
    const onAdd = vi.fn();
    render(<ScheduleAddMilestoneButton onAddMilestone={onAdd} />);
    fireEvent.click(screen.getByTestId('add-milestone-button'));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('disabled prop blocks the click handler', () => {
    const onAdd = vi.fn();
    render(<ScheduleAddMilestoneButton onAddMilestone={onAdd} disabled />);
    fireEvent.click(screen.getByTestId('add-milestone-button'));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('disabled state shows the read-only tooltip', () => {
    render(<ScheduleAddMilestoneButton onAddMilestone={vi.fn()} disabled />);
    expect(screen.getByTestId('add-milestone-button')).toHaveAttribute('title', 'Read-only access');
  });

  it('pending state blocks the click and shows wait cursor', () => {
    const onAdd = vi.fn();
    render(<ScheduleAddMilestoneButton onAddMilestone={onAdd} pending />);
    const btn = screen.getByTestId('add-milestone-button');
    fireEvent.click(btn);
    expect(onAdd).not.toHaveBeenCalled();
    expect(btn.className).toMatch(/cursor-wait/);
  });
});
