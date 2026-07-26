/**
 * Deleted-label notice and repair (#2394, frame D2).
 *
 * The behavior that matters most is the one that is invisible if you only click
 * through it: "Keep for now" must NOT rewrite the stored config, because the
 * dangling id is the only evidence the view was ever filtered on that label.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeletedLabelNotice } from './DeletedLabelNotice';
import type { BoardViewConfig } from '@/hooks/useBoardSavedViews';

const createLabelMutate = vi.fn();
vi.mock('@/hooks/useLabels', () => ({
  useCreateLabel: () => ({ mutate: createLabelMutate, isPending: false }),
}));
vi.mock('@/components/Toast', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

const CONFIG: BoardViewConfig = {
  sort: 'priority',
  showWip: false,
  showColTints: false,
  evmMode: 'off' as BoardViewConfig['evmMode'],
  showCost: false,
  riskLinkedOnly: false,
  filters: { assignees: ['a1'], priority: ['high'], due: [], labels: ['live-1', 'gone-1'] },
};

function renderNotice(over: Partial<Parameters<typeof DeletedLabelNotice>[0]> = {}) {
  const onRepair = vi.fn();
  render(
    <DeletedLabelNotice
      projectId="p1"
      viewId="v1"
      viewName="Q3 triage"
      config={CONFIG}
      missingIds={['gone-1']}
      matchCount={31}
      totalCount={214}
      isRepairing={false}
      onRepair={onRepair}
      {...over}
    />,
  );
  return { onRepair };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('DeletedLabelNotice — telling the user what happened', () => {
  it('states the consequence in the units on screen', () => {
    renderNotice();
    expect(screen.getByText(/31 of 214 rows · label filter not applied/)).toBeInTheDocument();
  });

  it('says the other filters are untouched, because they are', () => {
    renderNotice();
    expect(screen.getByText(/Your other filters are unchanged/)).toBeInTheDocument();
  });

  it('uses role="status", not "alert" — this is a condition, not an interruption', () => {
    renderNotice();
    expect(screen.getByTestId('deleted-label-notice')).toHaveAttribute('role', 'status');
  });

  it('renders nothing when no label is missing', () => {
    renderNotice({ missingIds: [] });
    expect(screen.queryByTestId('deleted-label-notice')).not.toBeInTheDocument();
  });
});

describe('DeletedLabelNotice — repair', () => {
  it('drops ONLY the missing id, preserving every other filter', () => {
    const { onRepair } = renderNotice();
    fireEvent.click(screen.getByRole('button', { name: 'Remove it from this view' }));

    expect(onRepair).toHaveBeenCalledTimes(1);
    const next = onRepair.mock.calls[0]?.[0] as BoardViewConfig;
    expect(next.filters?.labels).toEqual(['live-1']);
    // The whole promise of the copy: nothing else moved.
    expect(next.filters?.assignees).toEqual(['a1']);
    expect(next.filters?.priority).toEqual(['high']);
  });

  it('creates the replacement in the CURRENT project and points the view at it', async () => {
    createLabelMutate.mockImplementation(
      (_input: unknown, opts?: { onSuccess?: (l: { id: string }) => void }) => {
        opts?.onSuccess?.({ id: 'new-1' });
      },
    );
    const { onRepair } = renderNotice();

    fireEvent.click(screen.getByRole('button', { name: 'Create a replacement label' }));
    fireEvent.change(screen.getByLabelText('Name for the replacement label'), {
      target: { value: 'Rework' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createLabelMutate).toHaveBeenCalled());
    // A replacement is a NEW label in this project — never a resurrection of
    // whatever project the dangling id belonged to.
    expect(createLabelMutate.mock.calls[0]?.[0]).toEqual({ name: 'Rework', color: 'slate' });
    const next = onRepair.mock.calls[0]?.[0] as BoardViewConfig;
    expect(next.filters?.labels).toEqual(['live-1', 'new-1']);
  });

  it('will not create a label with a blank name', () => {
    renderNotice();
    fireEvent.click(screen.getByRole('button', { name: 'Create a replacement label' }));
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });
});

describe('DeletedLabelNotice — "Keep for now" is non-destructive', () => {
  it('dismisses WITHOUT rewriting the stored config', () => {
    const { onRepair } = renderNotice();
    fireEvent.click(screen.getByRole('button', { name: 'Keep for now' }));

    expect(screen.queryByTestId('deleted-label-notice')).not.toBeInTheDocument();
    // The dangling id is the only record that this view ever filtered on that
    // label. Rewriting the config here would destroy it silently.
    expect(onRepair).not.toHaveBeenCalled();
  });

  it('stays dismissed across a remount', () => {
    renderNotice();
    fireEvent.click(screen.getByRole('button', { name: 'Keep for now' }));
    renderNotice();
    expect(screen.queryByTestId('deleted-label-notice')).not.toBeInTheDocument();
  });

  it('speaks up again when a DIFFERENT label later goes missing', () => {
    renderNotice();
    fireEvent.click(screen.getByRole('button', { name: 'Keep for now' }));
    // A dismissal is keyed on the specific ids, so a new breakage is not
    // silently inherited by an old "keep".
    renderNotice({ missingIds: ['gone-2'] });
    expect(screen.getByTestId('deleted-label-notice')).toBeInTheDocument();
  });
});
