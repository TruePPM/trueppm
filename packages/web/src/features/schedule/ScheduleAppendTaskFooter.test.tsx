import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
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

describe('ScheduleAppendTaskFooter — row-height parity (#2952)', () => {
  function mockPointer(coarse: boolean) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('pointer: coarse') ? coarse : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      })),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // It read the `ROW_HEIGHT` live binding, which returns the right number once
  // and never re-renders when the pointer class flips — a tablet gaining a
  // keyboard left this row at the other class's height inside a correctly
  // resized outline. `useRowHeight()` is the subscription (#2997).
  it('takes its height from the same hook the outline rows use — fine pointer', () => {
    mockPointer(false);
    render(<ScheduleAppendTaskFooter onAppend={vi.fn()} ariaRowIndex={8} />);
    expect(screen.getByTestId('schedule-append-task-footer')).toHaveStyle({ height: '28px' });
  });

  it('takes its height from the same hook the outline rows use — coarse pointer', () => {
    mockPointer(true);
    render(<ScheduleAppendTaskFooter onAppend={vi.fn()} ariaRowIndex={8} />);
    expect(screen.getByTestId('schedule-append-task-footer')).toHaveStyle({ height: '44px' });
  });
});
