import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogTimePopover } from './LogTimePopover';

// Stub the write hooks so the popover is deterministic (no network). `create.mutate`
// invokes its onSuccess synchronously with a created entry so the undo toast wires up.
const { createMutate, deleteMutate } = vi.hoisted(() => ({
  createMutate: vi.fn(
    (_vars: unknown, opts?: { onSuccess?: (e: { id: string }) => void }) =>
      opts?.onSuccess?.({ id: 'created-1' }),
  ),
  deleteMutate: vi.fn(),
}));
vi.mock('@/hooks/useTimeEntry', async (importActual) => ({
  ...(await importActual<typeof import('@/hooks/useTimeEntry')>()),
  useCreateTimeEntry: () => ({ mutate: createMutate, isPending: false }),
  useDeleteTimeEntry: () => ({ mutate: deleteMutate, isPending: false }),
}));

const { toastAction, toastError } = vi.hoisted(() => ({
  toastAction: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@/components/Toast', () => ({
  toast: { action: toastAction, error: toastError },
}));

const TASK = {
  id: 'task-a',
  // A real 8-hex-digit value, never a pretty fake like the old 'RIV-1' — that
  // shape is exactly what hid the #2671 raw-hex leak (it already looks like a
  // nice identifier, so a render bug dumping the raw field passed silently).
  short_id: '00000001',
  short_id_display: 'T-1',
  qualified_id: 'RIV-1',
  name: 'Foundation',
  project_id: 'proj-1',
  project_name: 'Riverside',
};

beforeEach(() => {
  createMutate.mockClear();
  deleteMutate.mockClear();
  toastAction.mockClear();
  toastError.mockClear();
});

describe('LogTimePopover', () => {
  it('renders the server-decoded reference in the header, never the raw hex short_id (#2671)', () => {
    render(<LogTimePopover task={TASK} onClose={vi.fn()} />);
    expect(screen.getByText('Log time · RIV-1')).toBeInTheDocument();
    expect(screen.queryByText(/00000001/)).not.toBeInTheDocument();
  });

  it('maps a preset chip to minutes and reflects it on the Log button', () => {
    render(<LogTimePopover task={TASK} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '1h', pressed: false }));
    expect(screen.getByRole('button', { name: 'Log 1:00' })).toBeEnabled();
  });

  it('parses a custom h:mm value and overrides the preset', () => {
    render(<LogTimePopover task={TASK} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '15m' }));
    fireEvent.change(screen.getByLabelText(/Custom/i), { target: { value: '1:30' } });
    expect(screen.getByRole('button', { name: 'Log 1:30' })).toBeEnabled();
  });

  it('blocks logging on an unparseable custom value', () => {
    render(<LogTimePopover task={TASK} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Custom/i), { target: { value: 'abc' } });
    expect(screen.getByText('Enter hours like 1.5 or 1:30.')).toBeVisible();
    expect(screen.getByRole('button', { name: /^Log 0:00$/ })).toBeDisabled();
  });

  it('logs and fires the success + Undo toast, then Undo deletes the entry', () => {
    const onClose = vi.fn();
    render(<LogTimePopover task={TASK} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '2h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log 2:00' }));

    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toMatchObject({ taskId: 'task-a', minutes: 120 });
    expect(toastAction).toHaveBeenCalledTimes(1);
    expect(toastAction.mock.calls[0][0]).toBe('Logged 2:00 to RIV-1');
    expect(onClose).toHaveBeenCalled();

    // Invoke the Undo action the toast was given.
    const action = toastAction.mock.calls[0][1] as { onClick: () => void };
    action.onClick();
    expect(deleteMutate).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: 'created-1' }),
    );
  });

  it('closes on Cancel and on Escape', () => {
    const onClose = vi.fn();
    render(<LogTimePopover task={TASK} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
