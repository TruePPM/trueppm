import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileColumnStrip, type MobileColumnStripSegment } from './MobileColumnStrip';

const SEGMENTS: MobileColumnStripSegment[] = [
  { status: 'NOT_STARTED', label: 'To Do', count: 5 },
  { status: 'IN_PROGRESS', label: 'In Progress', count: 4 },
  { status: 'REVIEW', label: 'In Review', count: 2 },
  { status: 'COMPLETE', label: 'Done', count: 6 },
];

describe('MobileColumnStrip', () => {
  it('renders one segment per column with first-word name and count', () => {
    render(<MobileColumnStrip segments={SEGMENTS} activeIndex={1} onJump={() => {}} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
    // First word of the label + count is the visible text.
    expect(screen.getByText('To 5')).toBeInTheDocument();
    expect(screen.getByText('In 4')).toBeInTheDocument();
    expect(screen.getByText('Done 6')).toBeInTheDocument();
  });

  it('exposes the full label and count via aria-label (not just the first word)', () => {
    render(<MobileColumnStrip segments={SEGMENTS} activeIndex={0} onJump={() => {}} />);
    expect(screen.getByRole('button', { name: 'In Progress, 4 tasks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'In Review, 2 tasks' })).toBeInTheDocument();
  });

  it('singularizes the task count in the aria-label', () => {
    render(
      <MobileColumnStrip
        segments={[{ status: 'REVIEW', label: 'In Review', count: 1 }]}
        activeIndex={0}
        onJump={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'In Review, 1 task' })).toBeInTheDocument();
  });

  it('marks the active segment with aria-current and a data flag', () => {
    render(<MobileColumnStrip segments={SEGMENTS} activeIndex={2} onJump={() => {}} />);
    const active = screen.getByRole('button', { name: 'In Review, 2 tasks' });
    expect(active).toHaveAttribute('aria-current', 'true');
    expect(active).toHaveAttribute('data-active', 'true');
    // Non-active segments carry neither.
    const inactive = screen.getByRole('button', { name: 'Done, 6 tasks' });
    expect(inactive).not.toHaveAttribute('aria-current');
    expect(inactive).not.toHaveAttribute('data-active');
  });

  it('fires onJump with the tapped segment index', () => {
    const onJump = vi.fn();
    render(<MobileColumnStrip segments={SEGMENTS} activeIndex={0} onJump={onJump} />);
    fireEvent.click(screen.getByRole('button', { name: 'Done, 6 tasks' }));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(3);
  });

  it('labels the group as the board column map', () => {
    render(<MobileColumnStrip segments={SEGMENTS} activeIndex={0} onJump={() => {}} />);
    expect(screen.getByRole('group', { name: 'Board columns' })).toBeInTheDocument();
  });
});
