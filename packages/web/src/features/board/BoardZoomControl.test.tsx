/**
 * Tests for BoardZoomControl (#379, ADR-0145) — the board zoom stepper:
 * level label, bound-disabled steppers, click stepping, and arrow-key stepping.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BoardZoomControl } from './BoardZoomControl';

describe('BoardZoomControl', () => {
  it('shows the current level and exposes a labeled group', () => {
    render(<BoardZoomControl zoom="normal" onZoomChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Board zoom' })).toBeInTheDocument();
    expect(screen.getByText('Normal')).toBeInTheDocument();
  });

  it('disables zoom-out at the smallest level', () => {
    render(<BoardZoomControl zoom="small" onZoomChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
  });

  it('disables zoom-in at the largest level', () => {
    render(<BoardZoomControl zoom="large" onZoomChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled();
  });

  it('steps up and down by one level on click', async () => {
    const user = userEvent.setup();
    const onZoomChange = vi.fn();
    const { rerender } = render(<BoardZoomControl zoom="normal" onZoomChange={onZoomChange} />);
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(onZoomChange).toHaveBeenLastCalledWith('large');

    rerender(<BoardZoomControl zoom="normal" onZoomChange={onZoomChange} />);
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(onZoomChange).toHaveBeenLastCalledWith('small');
  });

  it('steps with arrow keys (AC #379)', async () => {
    const user = userEvent.setup();
    const onZoomChange = vi.fn();
    render(<BoardZoomControl zoom="normal" onZoomChange={onZoomChange} />);
    screen.getByRole('button', { name: 'Zoom in' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onZoomChange).toHaveBeenLastCalledWith('large');
    await user.keyboard('{ArrowLeft}');
    expect(onZoomChange).toHaveBeenLastCalledWith('small');
  });
});
