import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScheduleToolbarToggle } from './ScheduleToolbarToggle';

describe('ScheduleToolbarToggle', () => {
  it('renders the label', () => {
    render(<ScheduleToolbarToggle pressed={false} onToggle={vi.fn()} label="CP only" />);
    expect(screen.getByRole('button', { name: 'CP only' })).toBeInTheDocument();
  });

  it('reflects pressed state via aria-pressed', () => {
    const { rerender } = render(
      <ScheduleToolbarToggle pressed={false} onToggle={vi.fn()} label="x" />,
    );
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
    rerender(<ScheduleToolbarToggle pressed={true} onToggle={vi.fn()} label="x" />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('clicking calls onToggle with the inverse of the current value', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <ScheduleToolbarToggle pressed={false} onToggle={onToggle} label="x" />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenLastCalledWith(true);
    rerender(<ScheduleToolbarToggle pressed={true} onToggle={onToggle} label="x" />);
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  it('honors the ariaLabel override', () => {
    render(
      <ScheduleToolbarToggle
        pressed={false}
        onToggle={vi.fn()}
        label="CP"
        ariaLabel="Show critical path only"
      />,
    );
    expect(screen.getByRole('button', { name: 'Show critical path only' })).toBeInTheDocument();
  });
});
