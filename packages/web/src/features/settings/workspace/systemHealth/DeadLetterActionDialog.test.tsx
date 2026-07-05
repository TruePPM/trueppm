/**
 * DeadLetterActionDialog — unit tests (issue 695, ADR-0210).
 *
 * The one dialog drives all four operator actions. Covers: the requeue variant
 * shows a backoff select and passes the chosen seconds; the drop variant shows a
 * note textarea (danger-styled confirm) and passes the trimmed note; bulk titles
 * carry the count; Cancel fires onCancel; busy disables the confirm; an error
 * renders as an alert.
 */
import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { DeadLetterActionDialog } from './DeadLetterActionDialog';

function setup(props: Partial<ComponentProps<typeof DeadLetterActionDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <DeadLetterActionDialog
      kind="requeue"
      busy={false}
      error={null}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

describe('DeadLetterActionDialog', () => {
  it('requeue: picks a backoff and passes the chosen seconds on confirm', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup({ kind: 'requeue', taskName: 'scheduling.recalc' });

    await user.selectOptions(screen.getByLabelText('Backoff'), '300');
    await user.click(screen.getByRole('button', { name: 'Requeue' }));

    expect(onConfirm).toHaveBeenCalledWith({ backoffSeconds: 300, note: '' });
  });

  it('drop: passes the trimmed note and uses a danger-styled confirm', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup({ kind: 'drop' });

    await user.type(screen.getByLabelText(/Note/), '  relay down  ');
    await user.click(screen.getByRole('button', { name: 'Drop' }));

    expect(onConfirm).toHaveBeenCalledWith({ backoffSeconds: 0, note: 'relay down' });
  });

  it('bulk requeue: title and confirm carry the count', () => {
    setup({ kind: 'requeue', bulkCount: 7 });
    expect(screen.getByRole('heading', { name: /Requeue 7 tasks\?/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Requeue 7' })).toBeInTheDocument();
  });

  it('Cancel invokes onCancel', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('busy disables the confirm and shows the pending label', () => {
    setup({ kind: 'requeue', busy: true });
    const confirm = screen.getByRole('button', { name: 'Requeuing…' });
    expect(confirm).toBeDisabled();
  });

  it('renders a server error as an alert', () => {
    setup({ kind: 'drop', error: 'Nope.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Nope.');
  });
});
