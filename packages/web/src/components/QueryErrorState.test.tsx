import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { QueryErrorState } from './QueryErrorState';

afterEach(cleanup);

describe('QueryErrorState', () => {
  it('renders an alert with the given message and a Retry button', () => {
    render(<QueryErrorState message="Couldn't load the board." />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Couldn't load the board\./);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('falls back to a generic message when none is given', () => {
    render(<QueryErrorState />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't load data\./);
  });

  it('calls onRetry when the Retry button is clicked', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<QueryErrorState onRetry={onRetry} />);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('fill is a full-height assertive alert; inline is a polite bordered card', () => {
    const { rerender } = render(<QueryErrorState message="x" variant="fill" />);
    // fill = whole surface is dead → assertive alert.
    expect(screen.getByRole('alert').className).toMatch(/h-full/);
    rerender(<QueryErrorState message="x" variant="inline" />);
    // inline = one widget on a still-working page → polite status, bordered card.
    const inline = screen.getByRole('status');
    expect(inline.className).toMatch(/border/);
    expect(inline.className).toMatch(/min-h-24/);
  });
});
