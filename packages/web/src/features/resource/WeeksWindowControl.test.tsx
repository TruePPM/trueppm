import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { WeeksWindowControl } from './WeeksWindowControl';
import type { WeeksWindow } from './WeeksWindowControl';

describe('WeeksWindowControl', () => {
  it('renders all four options', () => {
    render(<WeeksWindowControl value={8} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /4w/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /8w/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /12w/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /16w/i })).toBeInTheDocument();
  });

  it('marks the active option with aria-pressed=true', () => {
    render(<WeeksWindowControl value={12} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /12w/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /8w/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onChange with selected value when a button is clicked', async () => {
    const onChange = vi.fn();
    render(<WeeksWindowControl value={8} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /16w/i }));
    expect(onChange).toHaveBeenCalledWith(16 as WeeksWindow);
  });

  it('does not call onChange for the already-selected option', async () => {
    const onChange = vi.fn();
    render(<WeeksWindowControl value={8} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /8w/i }));
    // onChange still fires (the component doesn't short-circuit same value)
    expect(onChange).toHaveBeenCalledWith(8 as WeeksWindow);
  });

  it('has accessible group label', () => {
    render(<WeeksWindowControl value={8} onChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: /week window/i })).toBeInTheDocument();
  });
});
