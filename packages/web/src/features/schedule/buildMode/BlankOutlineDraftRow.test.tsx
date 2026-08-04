import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BlankOutlineDraftRow } from './BlankOutlineDraftRow';

describe('BlankOutlineDraftRow (#2733)', () => {
  it('opens with the caret already in it', async () => {
    // The whole point of deleting the card: the first keystroke is the first task,
    // not the third click.
    render(<BlankOutlineDraftRow onCommit={vi.fn()} nameWidth={240} />);
    expect(await screen.findByRole('textbox', { name: /first task name/i })).toHaveFocus();
  });

  it('commits on Enter and keeps the caret for the next row', async () => {
    // "Structure accumulates as you type" only works if Enter does not eject you —
    // being thrown out of the field after each row would make typing a plan a
    // click-per-row exercise.
    const onCommit = vi.fn();
    render(<BlankOutlineDraftRow onCommit={onCommit} nameWidth={240} />);
    const input = screen.getByRole('textbox', { name: /first task name/i });

    await userEvent.type(input, 'Survey the site{Enter}');

    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Survey the site');
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
  });

  it('does not commit an empty or whitespace-only name', async () => {
    const onCommit = vi.fn();
    render(<BlankOutlineDraftRow onCommit={onCommit} nameWidth={240} />);
    const input = screen.getByRole('textbox', { name: /first task name/i });

    await userEvent.type(input, '   {Enter}');
    await userEvent.tab();

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits once, not twice, when Enter is followed by blur', async () => {
    // Committing clears and re-focuses the field; without the guard the blur that
    // follows would fire a second create with the stale value — a duplicate row
    // for every task typed.
    const onCommit = vi.fn();
    render(<BlankOutlineDraftRow onCommit={onCommit} nameWidth={240} />);
    const input = screen.getByRole('textbox', { name: /first task name/i });

    await userEvent.type(input, 'Pour foundations{Enter}');
    await userEvent.tab();

    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Pour foundations');
  });

  it('commits on blur when the field has content', async () => {
    // Clicking away with a typed name must not silently discard it.
    const onCommit = vi.fn();
    render(<BlankOutlineDraftRow onCommit={onCommit} nameWidth={240} />);
    await userEvent.type(screen.getByRole('textbox', { name: /first task name/i }), 'Draft');
    await userEvent.tab();

    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Draft');
  });

  it('Escape clears the draft without committing', async () => {
    const onCommit = vi.fn();
    render(<BlankOutlineDraftRow onCommit={onCommit} nameWidth={240} />);
    const input = screen.getByRole('textbox', { name: /first task name/i });

    await userEvent.type(input, 'Never mind{Escape}');

    expect(input).toHaveValue('');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('renders a static line, not an input, for a read-only role', () => {
    // A caret in a field that cannot save is a worse lie than no caret at all.
    render(<BlankOutlineDraftRow nameWidth={240} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('row')).toHaveTextContent(/no tasks yet/i);
  });
});
