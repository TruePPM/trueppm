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

  it('Enter inside the panel calls onAddFirstTask', () => {
    const onAdd = vi.fn();
    render(<BuildModeEmptyState onAddFirstTask={onAdd} />);
    const region = screen.getByRole('region');
    fireEvent.keyDown(region, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('non-Enter keys do not trigger the CTA', () => {
    const onAdd = vi.fn();
    render(<BuildModeEmptyState onAddFirstTask={onAdd} />);
    const region = screen.getByRole('region');
    fireEvent.keyDown(region, { key: 'a' });
    fireEvent.keyDown(region, { key: 'Tab' });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('mentions the ? cheatsheet hint', () => {
    render(<BuildModeEmptyState onAddFirstTask={vi.fn()} />);
    expect(screen.getByText(/keyboard shortcuts/)).toBeInTheDocument();
  });
});
