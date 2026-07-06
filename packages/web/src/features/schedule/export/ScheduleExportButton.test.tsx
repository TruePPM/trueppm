import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScheduleExportButton } from './ScheduleExportButton';

describe('ScheduleExportButton', () => {
  it('exposes an accessible name and a dialog haspopup', () => {
    render(<ScheduleExportButton disabled={false} onOpen={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Export schedule as PDF' });
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('calls onOpen when clicked', () => {
    const onOpen = vi.fn();
    render(<ScheduleExportButton disabled={false} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export schedule as PDF' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('is disabled and explains why when the schedule is empty', () => {
    const onOpen = vi.fn();
    render(<ScheduleExportButton disabled onOpen={onOpen} />);
    const btn = screen.getByRole('button', { name: 'Export schedule as PDF' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'No activities to export');
    fireEvent.click(btn);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('carries the shortcut hint in its title when enabled', () => {
    render(<ScheduleExportButton disabled={false} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Export schedule as PDF' })).toHaveAttribute(
      'title',
      'Export schedule as PDF · ⌘⇧E',
    );
  });
});
