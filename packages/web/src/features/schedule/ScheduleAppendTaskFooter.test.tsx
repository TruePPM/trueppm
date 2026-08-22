import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ScheduleAppendTaskFooter } from './ScheduleAppendTaskFooter';

describe('ScheduleAppendTaskFooter', () => {
  it('appends when activated, and says so on the label', async () => {
    const onAppend = vi.fn();
    const user = userEvent.setup();
    render(<ScheduleAppendTaskFooter onAppend={onAppend} ariaRowIndex={8} />);
    await user.click(screen.getByRole('button', { name: 'Add a task at the end' }));
    expect(onAppend).toHaveBeenCalledTimes(1);
  });

  it('declares the depth it lands at — top level, not inside anything', () => {
    render(<ScheduleAppendTaskFooter onAppend={vi.fn()} ariaRowIndex={8} />);
    const row = screen.getByTestId('schedule-append-task-footer');
    expect(row).toHaveAttribute('aria-level', '1');
    expect(row).toHaveAttribute('aria-rowindex', '8');
    expect(row).toHaveAttribute('role', 'row');
  });

  it('stays present and inert for an editor who chose Read', async () => {
    const onAppend = vi.fn();
    const user = userEvent.setup();
    render(<ScheduleAppendTaskFooter onAppend={onAppend} readOnly ariaRowIndex={8} />);
    const btn = screen.getByRole('button', { name: 'Add a task at the end' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Read-only access');
    await user.click(btn);
    expect(onAppend).not.toHaveBeenCalled();
  });
});
