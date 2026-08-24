import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BlankOutlineDraftRow } from './BlankOutlineDraftRow';

describe('BlankOutlineDraftRow (#2733)', () => {
  it('opens with the caret already in it', async () => {
    // The whole point of deleting the card: the first keystroke is the first task,
    // not the third click.
    render(<BlankOutlineDraftRow onCommit={vi.fn()} nameWidth={240} />);
    expect(await screen.findByRole('textbox', { name: /first item name/i })).toHaveFocus();
  });

  it('commits on Enter and keeps the caret for the next row', async () => {
    // "Structure accumulates as you type" only works if Enter does not eject you —
    // being thrown out of the field after each row would make typing a plan a
    // click-per-row exercise.
    const onCommit = vi.fn();
    render(<BlankOutlineDraftRow onCommit={onCommit} nameWidth={240} />);
    const input = screen.getByRole('textbox', { name: /first item name/i });

    await userEvent.type(input, 'Survey the site{Enter}');

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe('Survey the site');
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
  });

  it('does not commit an empty or whitespace-only name', async () => {
    const onCommit = vi.fn();
    render(<BlankOutlineDraftRow onCommit={onCommit} nameWidth={240} />);
    const input = screen.getByRole('textbox', { name: /first item name/i });

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
    const input = screen.getByRole('textbox', { name: /first item name/i });

    await userEvent.type(input, 'Pour foundations{Enter}');
    await userEvent.tab();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe('Pour foundations');
  });

  it('commits on blur when the field has content', async () => {
    // Clicking away with a typed name must not silently discard it.
    const onCommit = vi.fn();
    render(<BlankOutlineDraftRow onCommit={onCommit} nameWidth={240} />);
    await userEvent.type(screen.getByRole('textbox', { name: /first item name/i }), 'Draft');
    await userEvent.tab();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe('Draft');
  });

  it('Escape clears the draft without committing', async () => {
    const onCommit = vi.fn();
    render(<BlankOutlineDraftRow onCommit={onCommit} nameWidth={240} />);
    const input = screen.getByRole('textbox', { name: /first item name/i });

    await userEvent.type(input, 'Never mind{Escape}');

    expect(input).toHaveValue('');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('renders a static line, not an input, for a read-only role', () => {
    // A caret in a field that cannot save is a worse lie than no caret at all.
    render(<BlankOutlineDraftRow nameWidth={240} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('row')).toHaveTextContent(/no items yet/i);
  });
});

describe('BlankOutlineDraftRow — outline parity (#2952)', () => {
  // The outline is a `role="treegrid"`, where every `role="row"` must state its
  // depth. This row had no `aria-level` at all — and on a blank project it is
  // the ONLY row, so the one screen with nothing to announce was also the one
  // announcing it wrongly.
  it('carries aria-level like every other outline row', () => {
    render(<BlankOutlineDraftRow onCommit={vi.fn()} nameWidth={240} />);
    expect(screen.getByRole('row')).toHaveAttribute('aria-level', '1');
  });

  it('carries aria-level in the read-only variant too', () => {
    render(<BlankOutlineDraftRow nameWidth={240} />);
    const row = screen.getByRole('row');
    expect(row).toHaveAttribute('aria-level', '1');
    expect(row).toHaveTextContent('No items yet.');
  });

  it('restores the typed name when the create fails', async () => {
    // The field clears optimistically so a second row can be typed straight
    // away. Without this the only row on a blank project vanishes on a failed
    // POST and reads as "I never typed it".
    const onCommit = vi.fn((_name: string, opts?: { onError?: () => void }) => opts?.onError?.());
    render(<BlankOutlineDraftRow onCommit={onCommit} nameWidth={240} />);
    const input = screen.getByRole('textbox', { name: /first item name/i });

    await userEvent.type(input, 'Survey the site{Enter}');

    expect(input).toHaveValue('Survey the site');
  });

  it('does not clobber a half-typed replacement when an earlier create fails', async () => {
    let fail: (() => void) | undefined;
    const onCommit = vi.fn((_name: string, opts?: { onError?: () => void }) => {
      fail = opts?.onError;
    });
    render(<BlankOutlineDraftRow onCommit={onCommit} nameWidth={240} />);
    const input = screen.getByRole('textbox', { name: /first item name/i });

    await userEvent.type(input, 'First row{Enter}');
    await userEvent.type(input, 'Second row');
    fail?.();

    expect(input).toHaveValue('Second row');
  });
});

describe('BlankOutlineDraftRow — the left-edge lanes (#3026)', () => {
  it('spaces by the SAME reserve a real row does, so the first task lines up', () => {
    // The one row a blank project types its first task into. If it spaces by the
    // grip lane alone, the caret sits a nudge lane left of where every row that
    // follows it will draw — and the jump happens the instant the task commits.
    render(<BlankOutlineDraftRow onCommit={vi.fn()} nameWidth={240} leftReserve={134} />);
    const row = screen.getByRole('row');
    const lane = row.querySelector<HTMLElement>(':scope > span[aria-hidden="true"]');
    expect(lane).not.toBeNull();
    expect(lane!.style.width).toBe('134px');
  });

  it('reserves nothing when the panel reserves nothing', () => {
    render(<BlankOutlineDraftRow onCommit={vi.fn()} nameWidth={240} />);
    const row = screen.getByRole('row');
    expect(row.querySelector(':scope > span[aria-hidden="true"]')).toBeNull();
  });
});

/**
 * The vocabulary lock on the blank-project placeholder (#3027).
 *
 * This row IS the placeholder surface the rule names, and it is the first thing
 * a new project shows — so "Type your first task" is the product's opening claim
 * about what the user is allowed to create, made before they have chosen a type
 * and directly beside the `+ Phase` and `+ Milestone` paths that say otherwise.
 */
describe('BlankOutlineDraftRow — the vocabulary lock (#3027)', () => {
  it('invites an item, not a task', () => {
    render(<BlankOutlineDraftRow onCommit={vi.fn()} nameWidth={240} />);
    const input = screen.getByRole('textbox', { name: 'First item name' });
    expect(input).toHaveAttribute('placeholder', 'Type your first item, then press Enter');
  });

  it('says "No items yet." on the read-only variant', () => {
    render(<BlankOutlineDraftRow nameWidth={240} />);
    expect(screen.getByRole('row')).toHaveTextContent('No items yet.');
    expect(screen.getByRole('row')).not.toHaveTextContent(/no tasks yet/i);
  });
});
