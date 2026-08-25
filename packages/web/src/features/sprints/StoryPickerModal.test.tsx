import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProvidersAndRouter } from '@/test/utils';
import type { Task } from '@/types';
import type { ProductBacklog } from '@/features/project/backlog/types';
import { StoryPickerModal } from './StoryPickerModal';
import { makeSprint } from './sprintTestFixtures';

const mutateAsyncMock = vi.fn();
vi.mock('@/hooks/useTaskMutations', () => ({
  useBulkUpdateTasks: () => ({ mutateAsync: mutateAsyncMock }),
}));

/** A 207 body with the buckets the picker reads (`task_bulk.py::BulkOutcome`). */
function bulk207(over: {
  applied?: { index: number; id: string }[];
  rejected?: { index: number; id: string | null; code: string; message: string }[];
  skipped?: { index: number; id: string | null; code: string; message: string }[];
}) {
  return {
    applied: (over.applied ?? []).map((a) => ({ ...a, op: 'update', outcome: 'updated' })),
    rejected: over.rejected ?? [],
    skipped: over.skipped ?? [],
    operation_id: null,
  };
}

const { toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));
vi.mock('@/components/Toast/toast', () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

const useProductBacklogMock = vi.fn();
vi.mock('@/features/project/backlog/hooks/useProductBacklog', () => ({
  useProductBacklog: () => useProductBacklogMock() as unknown,
}));

function story(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? 'story-1',
    name: overrides.name ?? 'Pay with card',
    dor: overrides.dor ?? 'ready',
    dorBlockers: overrides.dorBlockers,
    storyPoints: overrides.storyPoints ?? 3,
    sprintId: null,
    sprintPending: false,
    assignees: [],
    ...overrides,
  } as unknown as Task;
}

function backlog(overrides: Partial<ProductBacklog> = {}): ProductBacklog {
  return {
    epics: [],
    ungrouped: [
      story({ id: 's1', name: 'Ready story A', dor: 'ready', storyPoints: 3 }),
      story({ id: 's2', name: 'Ready story B', dor: 'ready', storyPoints: 5 }),
      story({
        id: 's3',
        name: 'Unrefined story C',
        dor: 'refine',
        storyPoints: null,
        dorBlockers: ['unestimated', 'no_acceptance_criteria'],
      }),
    ],
    health: {
      dorPct: 67,
      readyCount: 2,
      readyPoints: 8,
      capacityPoints: 20,
      unestimated: 1,
      acMet: 0,
      acTotal: 0,
      storyCount: 3,
    },
    scoring: { model: 'none' },
    ...overrides,
  };
}

const SPRINT = makeSprint({ id: 'sp-1', short_id_display: 'SP-A1', capacity_points: 20 });

beforeEach(() => {
  mutateAsyncMock.mockReset();
  mutateAsyncMock.mockResolvedValue(
    bulk207({
      applied: [
        { index: 0, id: 's1' },
        { index: 1, id: 's2' },
      ],
    }),
  );
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  useProductBacklogMock.mockReset();
  useProductBacklogMock.mockReturnValue({ data: backlog(), isLoading: false, isError: false });
});

function renderModal(props: Partial<Parameters<typeof StoryPickerModal>[0]> = {}) {
  return renderWithProvidersAndRouter(
    <StoryPickerModal
      projectId="proj-1"
      sprint={SPRINT}
      committedPoints={0}
      readyOnlyDefault={true}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

describe('StoryPickerModal', () => {
  it('renders as a dialog naming the target sprint', () => {
    renderModal();
    expect(screen.getByRole('dialog', { name: /Pull stories into SP-A1/i })).toBeInTheDocument();
  });

  it('defaults to Ready only, hiding the not-ready story with a "Show all" escape hatch', () => {
    renderModal({ readyOnlyDefault: true });
    expect(screen.getByText('Ready story A')).toBeInTheDocument();
    expect(screen.getByText('Ready story B')).toBeInTheDocument();
    expect(screen.queryByText('Unrefined story C')).not.toBeInTheDocument();
    expect(screen.getByText(/1 not-ready story is hidden/i)).toBeInTheDocument();
  });

  it('"Show all" reveals the not-ready story dimmed, with its blocker reasons', async () => {
    const user = userEvent.setup();
    renderModal({ readyOnlyDefault: true });
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByText('Unrefined story C')).toBeInTheDocument();
    expect(screen.getByText(/needs an estimate/i)).toBeInTheDocument();
    expect(screen.getByText(/add at least one acceptance criterion/i)).toBeInTheDocument();
  });

  it('respects readyOnlyDefault=false, showing everything ready-first by default', () => {
    renderModal({ readyOnlyDefault: false });
    expect(screen.getByText('Ready story A')).toBeInTheDocument();
    expect(screen.getByText('Unrefined story C')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Show all' })).toBeChecked();
  });

  it('updates the selection count, points, and live capacity chip as stories are picked', async () => {
    const user = userEvent.setup();
    renderModal({ committedPoints: 2 });
    await user.click(screen.getByRole('button', { name: 'Ready story A' }));
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
    expect(screen.getByText(/3 pts/i)).toBeInTheDocument();
    // committedPoints (2) + selected (3) = 5 of 20 capacity.
    expect(screen.getByText(/If committed: 5\/20 pts/i)).toBeInTheDocument();
  });

  it('warns advisory-only when a not-ready story is selected — commit stays enabled (OSS never hard-blocks)', async () => {
    const user = userEvent.setup();
    renderModal({ readyOnlyDefault: false });
    await user.click(screen.getByRole('button', { name: /Unrefined story C/i }));
    expect(
      screen.getByText(/1 selected story is not marked Ready — you can still pull it/i),
    ).toBeInTheDocument();
    const commitButton = screen.getByRole('button', { name: /Commit 1 story/i });
    expect(commitButton).toBeEnabled();
  });

  it('commits the selection as ONE tasks/bulk batch and closes on a fully-applied 207 (golden path)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal({ onClose });
    await user.click(screen.getByRole('button', { name: 'Ready story A' }));
    await user.click(screen.getByRole('button', { name: 'Ready story B' }));
    await user.click(screen.getByRole('button', { name: /Commit 2 stories/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // One request, not N: this is the whole point of #2914.
    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(mutateAsyncMock).toHaveBeenCalledWith([
      { op: 'update', id: 's1', data: { sprint: 'sp-1' } },
      { op: 'update', id: 's2', data: { sprint: 'sp-1' } },
    ]);
    expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining('2 stories'));
  });

  it('renders the 207 buckets per row on a partial commit — committed count, rejected row, reason', async () => {
    const user = userEvent.setup();
    mutateAsyncMock.mockResolvedValue(
      bulk207({
        applied: [{ index: 0, id: 's1' }],
        rejected: [
          { index: 1, id: 's2', code: 'forbidden', message: 'You may not edit this task.' },
        ],
      }),
    );
    const onClose = vi.fn();
    renderModal({ onClose });
    await user.click(screen.getByRole('button', { name: 'Ready story A' }));
    await user.click(screen.getByRole('button', { name: 'Ready story B' }));
    await user.click(screen.getByRole('button', { name: /Commit 2 stories/i }));

    const result = await screen.findByTestId('story-picker-result');
    expect(result).toHaveTextContent(/Committed 1 of 2 stories to SP-A1/i);
    expect(result).toHaveTextContent('Ready story B');
    expect(result).toHaveTextContent('You may not edit this task.');
    expect(onClose).not.toHaveBeenCalled();
    // The picker table is gone — the dialog is reconciling, not still picking.
    expect(screen.queryByRole('button', { name: /Commit 2 stories/i })).not.toBeInTheDocument();
  });

  it('retries only the rejected rows, never the ones that already landed', async () => {
    const user = userEvent.setup();
    mutateAsyncMock.mockResolvedValueOnce(
      bulk207({
        applied: [{ index: 0, id: 's1' }],
        rejected: [{ index: 1, id: 's2', code: 'conflict', message: 'Try again.' }],
      }),
    );
    const onClose = vi.fn();
    renderModal({ onClose });
    await user.click(screen.getByRole('button', { name: 'Ready story A' }));
    await user.click(screen.getByRole('button', { name: 'Ready story B' }));
    await user.click(screen.getByRole('button', { name: /Commit 2 stories/i }));

    mutateAsyncMock.mockResolvedValueOnce(bulk207({ applied: [{ index: 0, id: 's2' }] }));
    await user.click(await screen.findByRole('button', { name: /Retry 1 story/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mutateAsyncMock).toHaveBeenLastCalledWith([
      { op: 'update', id: 's2', data: { sprint: 'sp-1' } },
    ]);
  });

  it('lists a skipped row as left-unchanged and offers no retry for it', async () => {
    const user = userEvent.setup();
    mutateAsyncMock.mockResolvedValue(
      bulk207({
        applied: [{ index: 0, id: 's1' }],
        skipped: [
          {
            index: 1,
            id: 's2',
            code: 'tombstoned',
            message: 'That id belongs to a deleted row; not re-created.',
          },
        ],
      }),
    );
    renderModal();
    await user.click(screen.getByRole('button', { name: 'Ready story A' }));
    await user.click(screen.getByRole('button', { name: 'Ready story B' }));
    await user.click(screen.getByRole('button', { name: /Commit 2 stories/i }));

    const result = await screen.findByTestId('story-picker-result');
    expect(result).toHaveTextContent(/1 left unchanged/i);
    expect(result).toHaveTextContent('That id belongs to a deleted row');
    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('states that NOTHING was committed when the request itself fails, keeping the selection', async () => {
    const user = userEvent.setup();
    mutateAsyncMock.mockRejectedValue(new Error('network error'));
    const onClose = vi.fn();
    renderModal({ onClose });
    await user.click(screen.getByRole('button', { name: 'Ready story A' }));
    await user.click(screen.getByRole('button', { name: 'Ready story B' }));
    await user.click(screen.getByRole('button', { name: /Commit 2 stories/i }));

    // The batch is one transaction, so a failed request wrote nothing — say so
    // rather than leaving the user to guess which half landed.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /no stories were pulled into SP-A1/i,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
    expect(screen.queryByTestId('story-picker-result')).not.toBeInTheDocument();
  });

  it('shows an empty state with a link to the full backlog when there is nothing to pull', () => {
    useProductBacklogMock.mockReturnValue({
      data: backlog({ ungrouped: [] }),
      isLoading: false,
      isError: false,
    });
    renderModal();
    expect(screen.getByText(/The backlog is empty/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Manage full backlog/i });
    expect(link).toHaveAttribute('href', '/projects/proj-1/product-backlog');
  });

  it('filters visible stories by search query', async () => {
    const user = userEvent.setup();
    renderModal({ readyOnlyDefault: false });
    await user.type(screen.getByRole('textbox', { name: /search backlog stories/i }), 'Story A');
    expect(screen.getByText('Ready story A')).toBeInTheDocument();
    expect(screen.queryByText('Ready story B')).not.toBeInTheDocument();
    expect(screen.queryByText('Unrefined story C')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal({ onClose });
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
