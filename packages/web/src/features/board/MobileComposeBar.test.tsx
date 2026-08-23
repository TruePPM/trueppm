import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MobileComposeBar } from './MobileComposeBar';

/**
 * The touch compose bar (#2952) — what the mobile FAB opens now that it no
 * longer opens `TaskFormModal` as a full-screen sheet.
 */
describe('MobileComposeBar', () => {
  it('opens with the caret in the field', () => {
    render(<MobileComposeBar destinationLabel="To Do" onCommit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: /lands in To Do/i })).toHaveFocus();
  });

  it('names where a committed row lands', () => {
    render(<MobileComposeBar destinationLabel="Backlog" onCommit={vi.fn()} onClose={vi.fn()} />);
    // The destination is derived from the column swiped into view, so it moves
    // under the user without them touching anything that looks like a setting.
    expect(screen.getByText('Backlog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
  });

  it('commits on Enter and keeps the caret for the next item', async () => {
    const onCommit = vi.fn();
    render(<MobileComposeBar destinationLabel="To Do" onCommit={onCommit} onClose={vi.fn()} />);
    const field = screen.getByRole('textbox', { name: /lands in To Do/i });

    await userEvent.type(field, 'Check the riser bolts{Enter}');

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe('Check the riser bolts');
    // Intake on a phone is bursty — a site walk produces five items, not one.
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
  });

  it('commits from the Add button, which is the touch path', async () => {
    const onCommit = vi.fn();
    render(<MobileComposeBar destinationLabel="To Do" onCommit={onCommit} onClose={vi.fn()} />);
    const field = screen.getByRole('textbox', { name: /lands in To Do/i });
    fireEvent.change(field, { target: { value: 'Photograph the panel' } });

    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBe('Photograph the panel');
  });

  it('commits nothing for an empty or whitespace-only name', async () => {
    const onCommit = vi.fn();
    render(<MobileComposeBar destinationLabel="To Do" onCommit={onCommit} onClose={vi.fn()} />);
    const field = screen.getByRole('textbox', { name: /lands in To Do/i });

    await userEvent.type(field, '   {Enter}');

    expect(onCommit).not.toHaveBeenCalled();
    // A whitespace name never arms the button either.
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('restores the typed name when the create fails', async () => {
    // The bar clears optimistically so the next item can be typed straight
    // away; a silent POST failure would otherwise lose it with no trace, on a
    // surface whose whole job is catching things in the field.
    const onCommit = vi.fn((_name: string, opts?: { onError?: () => void }) => opts?.onError?.());
    render(<MobileComposeBar destinationLabel="To Do" onCommit={onCommit} onClose={vi.fn()} />);
    const field = screen.getByRole('textbox', { name: /lands in To Do/i });

    await userEvent.type(field, 'Chase the vendor{Enter}');

    expect(field).toHaveValue('Chase the vendor');
  });

  it('does not clobber a half-typed replacement when an earlier create fails', async () => {
    let fail: (() => void) | undefined;
    const onCommit = vi.fn((_name: string, opts?: { onError?: () => void }) => {
      fail = opts?.onError;
    });
    render(<MobileComposeBar destinationLabel="To Do" onCommit={onCommit} onClose={vi.fn()} />);
    const field = screen.getByRole('textbox', { name: /lands in To Do/i });

    await userEvent.type(field, 'First item{Enter}');
    await userEvent.type(field, 'Second item');
    fail?.();

    expect(field).toHaveValue('Second item');
  });

  it('goes inert while a create is in flight', () => {
    render(
      <MobileComposeBar destinationLabel="To Do" onCommit={vi.fn()} onClose={vi.fn()} isPending />,
    );
    // `readOnly`, not `disabled` — a disabled input is blurred by the browser,
    // which on a phone closes the soft keyboard between every item.
    const field = screen.getByRole('textbox', { name: /lands in To Do/i });
    expect(field).toHaveAttribute('readonly');
    expect(field).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
  });

  it('closes on Escape and from the × button', async () => {
    const onClose = vi.fn();
    render(<MobileComposeBar destinationLabel="To Do" onCommit={vi.fn()} onClose={onClose} />);
    const field = screen.getByRole('textbox', { name: /lands in To Do/i });

    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Escape is bound to the bar, so it still fires with focus on a button —
    // the field advertises the shortcut, and an input-bound handler would stop
    // honoring it the moment the user tabbed off.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close compose bar' }), {
      key: 'Escape',
    });
    expect(onClose).toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByRole('button', { name: 'Close compose bar' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('keeps the caret in the field across a pending create', async () => {
    const { rerender } = render(
      <MobileComposeBar destinationLabel="To Do" onCommit={vi.fn()} onClose={vi.fn()} />,
    );
    const field = screen.getByRole('textbox', { name: /lands in To Do/i });
    await userEvent.type(field, 'Check the riser bolts{Enter}');

    rerender(
      <MobileComposeBar destinationLabel="To Do" onCommit={vi.fn()} onClose={vi.fn()} isPending />,
    );

    // The whole advantage over the sheet is that a run of items costs one tap.
    expect(field).toHaveFocus();
  });

  it('meets the 44px touch floor on both controls (rule 5)', () => {
    render(<MobileComposeBar destinationLabel="To Do" onCommit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: /lands in To Do/i })).toHaveStyle({
      height: '44px',
    });
    expect(screen.getByRole('button', { name: 'Add' })).toHaveStyle({ height: '44px' });
  });
});
