import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ModalDialog } from './ModalDialog';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <ModalDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Re-baseline"
        description="This is recorded."
        footer={<button type="button">Confirm</button>}
      >
        Body
      </ModalDialog>
    </>
  );
}

describe('ModalDialog', () => {
  it('is a named modal dialog that traps Tab, closes on Escape and restores focus', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Re-baseline' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('This is recorded.');
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes on the scrim', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.pointerDown(screen.getByTestId('modal-scrim'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores Escape, scrim and close while busy', async () => {
    const onClose = vi.fn();
    render(
      <ModalDialog open onClose={onClose} title="Saving" busy>
        Body
      </ModalDialog>,
    );
    await userEvent.keyboard('{Escape}');
    fireEvent.pointerDown(screen.getByTestId('modal-scrim'));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
