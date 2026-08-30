import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StartWayCards } from './StartWayCards';

describe('StartWayCards (#2728)', () => {
  it('renders the three peer ways, same size, same row — no fourth "Seed from a brief"', () => {
    render(<StartWayCards value="blank" onChange={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: /start from/i });
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /template/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /blank/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /import/i })).toBeInTheDocument();
    expect(screen.queryByText(/seed from a brief/i)).not.toBeInTheDocument();
  });

  it('marks the current value checked and the others not', () => {
    render(<StartWayCards value="import" onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /import/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /^blank/i })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: /^template/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('commits a selection on click', async () => {
    const onChange = vi.fn();
    render(<StartWayCards value="blank" onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: /^template/i }));
    expect(onChange).toHaveBeenCalledWith('template');
  });

  it('ArrowRight/ArrowLeft moves focus across the row without committing (roving tabindex)', async () => {
    const onChange = vi.fn();
    render(<StartWayCards value="template" onChange={onChange} />);
    const template = screen.getByRole('radio', { name: /^template/i });
    const blank = screen.getByRole('radio', { name: /^blank/i });
    template.focus();

    await userEvent.keyboard('{ArrowRight}');
    expect(blank).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.keyboard('{ArrowLeft}');
    expect(template).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a letter key jumps straight to and commits the matching way', async () => {
    const onChange = vi.fn();
    render(<StartWayCards value="blank" onChange={onChange} />);
    const template = screen.getByRole('radio', { name: /^template/i });
    const blank = screen.getByRole('radio', { name: /^blank/i });
    blank.focus();

    await userEvent.keyboard('t');
    expect(template).toHaveFocus();
    expect(onChange).toHaveBeenCalledWith('template');

    await userEvent.keyboard('i');
    expect(screen.getByRole('radio', { name: /^import/i })).toHaveFocus();
    expect(onChange).toHaveBeenCalledWith('import');
  });

  it('compact lays the ways out two per row — 2 + 1 with today’s three ways (#3130)', () => {
    // The docblock used to call this "2×2", written when a fourth way was still
    // planned. The grid is `grid-cols-2` and there are three cards, so the second
    // row holds one — pinning both here keeps the prose and the class in step.
    render(<StartWayCards value="blank" onChange={vi.fn()} compact />);
    const group = screen.getByRole('radiogroup', { name: /start from/i });
    expect(group.className).toContain('grid-cols-2');
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(3);
  });

  it('only the roving-focus card is a Tab stop', () => {
    render(<StartWayCards value="import" onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /^import/i })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: /^template/i })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('radio', { name: /^blank/i })).toHaveAttribute('tabindex', '-1');
  });
});
