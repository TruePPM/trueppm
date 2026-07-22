import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ResourceOverallocationDrawer,
  type OverallocationTarget,
} from './ResourceOverallocationDrawer';

// Control the responsive shell. The #2148 fix renders exactly ONE shell per
// breakpoint (rule 211) instead of CSS-hiding a second copy, so this mock lets us
// assert there is never a double-mounted dialog.
const mockBreakpoint = vi.fn<() => 'sm' | 'md' | 'lg'>();
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => mockBreakpoint(),
}));

const target = {
  resourceId: 'r1',
  resourceName: 'Anna Khoury',
  iso: '2026-04-20',
  entry: { hours: 10, load_pct: 125, tasks: [] },
  hoursPerDay: 8,
  maxUnits: 1,
} as unknown as OverallocationTarget;

describe('ResourceOverallocationDrawer responsive shell (#2148)', () => {
  beforeEach(() => mockBreakpoint.mockReset());

  it('renders exactly one dialog on desktop — the right-side panel, no double-mount', () => {
    mockBreakpoint.mockReturnValue('lg');
    render(<ResourceOverallocationDrawer target={target} isOpen onClose={vi.fn()} />);
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].className).toContain('w-[480px]');
    expect(dialogs[0].className).toContain('right-0');
  });

  it('renders exactly one dialog on mobile — the bottom sheet', () => {
    mockBreakpoint.mockReturnValue('sm');
    render(<ResourceOverallocationDrawer target={target} isOpen onClose={vi.fn()} />);
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].className).toContain('rounded-t-card');
    expect(dialogs[0].className).toContain('bottom-0');
  });

  it('binds the close button to the visible shell and fires onClose', async () => {
    mockBreakpoint.mockReturnValue('lg');
    const onClose = vi.fn();
    render(<ResourceOverallocationDrawer target={target} isOpen onClose={onClose} />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Close overallocation drawer' }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('marks the shell aria-hidden when closed', () => {
    mockBreakpoint.mockReturnValue('lg');
    render(<ResourceOverallocationDrawer target={null} isOpen={false} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { hidden: true })).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });
});
