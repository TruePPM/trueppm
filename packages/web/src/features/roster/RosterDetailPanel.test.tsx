/**
 * RosterDetailPanel failure-feedback tests (#2150).
 *
 * The panel's capacity edit and resource removal had no error path: a failed
 * PATCH silently didn't stick, and a non-cascade (403/500/network) delete
 * produced zero feedback. These cover the toasts that now surface those.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ProjectResource } from '@/types';
import { RosterDetailPanel } from './RosterDetailPanel';

const { updateMutate, removeMutate, toastErrorMock } = vi.hoisted(() => ({
  updateMutate: vi.fn(),
  removeMutate: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('@/hooks/useProjectResourcePool', () => ({
  useUpdateProjectResource: () => ({ mutate: updateMutate, isPending: false }),
  useRemoveProjectResource: () => ({ mutate: removeMutate, isPending: false }),
}));
vi.mock('@/components/Toast/toast', () => ({ toast: { error: toastErrorMock } }));

// Stub the capacity editor so a change fires handleCapacityChange directly.
vi.mock('./CapacityInput', () => ({
  CapacityInput: ({ onChange }: { onChange: (v: number) => void }) => (
    <button type="button" onClick={() => onChange(5)}>
      change-capacity
    </button>
  ),
}));
// Stub the cascade dialog to expose its confirm action.
vi.mock('./CascadeDeleteDialog', () => ({
  CascadeDeleteDialog: ({ onConfirm }: { onConfirm: () => void }) => (
    <button type="button" onClick={onConfirm}>
      confirm-cascade
    </button>
  ),
}));

function makeProjectResource(): ProjectResource {
  return {
    id: 'pr-1',
    projectId: 'p1',
    unitsOverride: null,
    effectiveMaxUnits: 1,
    roleTitle: null,
    notes: '',
    resource: { id: 'r-1', name: 'Alex', skills: [] },
  } as unknown as ProjectResource;
}

beforeEach(() => {
  updateMutate.mockReset();
  removeMutate.mockReset();
  toastErrorMock.mockReset();
});

describe('RosterDetailPanel — failure feedback (#2150)', () => {
  it('toasts when a capacity save fails', () => {
    render(<RosterDetailPanel projectResource={makeProjectResource()} />);
    fireEvent.click(screen.getByRole('button', { name: 'change-capacity' }));
    const opts = updateMutate.mock.calls[0][1] as { onError: () => void };
    opts.onError();
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't save the capacity override — try again.");
  });

  it('toasts a non-cascade (403/500/network) removal failure', () => {
    render(<RosterDetailPanel projectResource={makeProjectResource()} />);
    fireEvent.click(screen.getByRole('button', { name: /Remove from project/i }));
    const opts = removeMutate.mock.calls[0][1] as { onError: (e: unknown) => void };
    opts.onError({ response: { status: 500 } });
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't remove the resource — try again.");
  });

  it('does NOT toast for a 409 (that opens the cascade dialog instead)', () => {
    render(<RosterDetailPanel projectResource={makeProjectResource()} />);
    fireEvent.click(screen.getByRole('button', { name: /Remove from project/i }));
    const opts = removeMutate.mock.calls[0][1] as { onError: (e: unknown) => void };
    act(() => opts.onError({ response: { status: 409, data: { cascaded_assignment_count: 3 } } }));
    expect(toastErrorMock).not.toHaveBeenCalled();
    // The cascade dialog is now shown.
    expect(screen.getByRole('button', { name: 'confirm-cascade' })).toBeInTheDocument();
  });

  it('toasts when the force (cascade) removal fails', () => {
    render(<RosterDetailPanel projectResource={makeProjectResource()} />);
    // Reach the cascade dialog via a 409 on the soft delete.
    fireEvent.click(screen.getByRole('button', { name: /Remove from project/i }));
    const softOpts = removeMutate.mock.calls[0][1] as { onError: (e: unknown) => void };
    act(() =>
      softOpts.onError({ response: { status: 409, data: { cascaded_assignment_count: 2 } } }),
    );
    // Confirm the cascade → force delete fires a second mutate.
    fireEvent.click(screen.getByRole('button', { name: 'confirm-cascade' }));
    const forceOpts = removeMutate.mock.calls[1][1] as { onError: () => void };
    act(() => forceOpts.onError());
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't remove the resource — try again.");
  });
});
