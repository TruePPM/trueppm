import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ModeToggle } from './ModeToggle';

describe('ModeToggle', () => {
  it('renders three buttons with descriptive aria-labels', () => {
    render(<ModeToggle mode="outline" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Flat list' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Outline tree' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Grouped' })).toBeInTheDocument();
  });

  it('marks the active mode with aria-pressed=true', () => {
    render(<ModeToggle mode="grouped" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Grouped' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Flat list' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Outline tree' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onChange when a button is clicked', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ModeToggle mode="outline" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Flat list' }));
    expect(onChange).toHaveBeenCalledWith('flat');
  });

  it('cycles forward with ArrowRight', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ModeToggle mode="flat" onChange={onChange} />);
    const flatBtn = screen.getByRole('button', { name: 'Flat list' });
    flatBtn.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('outline');
  });

  it('cycles backward with ArrowLeft (wraps from flat to grouped)', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ModeToggle mode="flat" onChange={onChange} />);
    const flatBtn = screen.getByRole('button', { name: 'Flat list' });
    flatBtn.focus();
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenCalledWith('grouped');
  });

  it('ignores other keys', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ModeToggle mode="outline" onChange={onChange} />);
    const btn = screen.getByRole('button', { name: 'Outline tree' });
    btn.focus();
    await user.keyboard('{ArrowUp}');
    await user.keyboard('a');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uses role="group" with the Display mode label (not tablist)', () => {
    render(<ModeToggle mode="flat" onChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: /display mode/i })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });
});
