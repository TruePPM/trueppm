import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BuildModeEmptyState } from './BuildModeEmptyState';

describe('BuildModeEmptyState', () => {
  it('renders the heading and CTA', () => {
    render(<BuildModeEmptyState onAddFirstTask={vi.fn()} />);
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add first task/i })).toBeInTheDocument();
  });

  it('clicking CTA calls onAddFirstTask', () => {
    const onAdd = vi.fn();
    render(<BuildModeEmptyState onAddFirstTask={onAdd} />);
    fireEvent.click(screen.getByRole('button', { name: /Add first task/i }));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('auto-focuses the CTA so Enter triggers the action natively', () => {
    render(<BuildModeEmptyState onAddFirstTask={vi.fn()} />);
    const button = screen.getByRole('button', { name: /Add first task/i });
    expect(document.activeElement).toBe(button);
  });

  it('non-Enter keys do not trigger the CTA', () => {
    const onAdd = vi.fn();
    render(<BuildModeEmptyState onAddFirstTask={onAdd} />);
    const button = screen.getByRole('button', { name: /Add first task/i });
    fireEvent.keyDown(button, { key: 'a' });
    fireEvent.keyDown(button, { key: 'Tab' });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('mentions the ? cheatsheet hint', () => {
    render(<BuildModeEmptyState onAddFirstTask={vi.fn()} />);
    expect(screen.getByText(/keyboard shortcuts/)).toBeInTheDocument();
  });

  // #2682: build mode is now the desktop default, so a read-only Viewer landing
  // on an empty schedule reaches this state too — omitting the callback (the
  // same contract as ScheduleEmptyState's onAddTask) must hide the CTA rather
  // than render a button that silently no-ops.
  it('omits the CTA for a read-only viewer (no onAddFirstTask)', () => {
    render(<BuildModeEmptyState />);
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add first task/i })).toBeNull();
    expect(screen.getByText(/No tasks have been added to this schedule yet/)).toBeInTheDocument();
  });
});
