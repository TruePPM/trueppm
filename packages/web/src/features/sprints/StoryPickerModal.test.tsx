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
  useUpdateTask: () => ({ mutateAsync: mutateAsyncMock }),
}));

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
  mutateAsyncMock.mockResolvedValue({});
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

  it('commits selected stories via PATCH sprint=<id> and closes on success (golden path)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal({ onClose });
    await user.click(screen.getByRole('button', { name: 'Ready story A' }));
    await user.click(screen.getByRole('button', { name: 'Ready story B' }));
    await user.click(screen.getByRole('button', { name: /Commit 2 stories/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mutateAsyncMock).toHaveBeenCalledWith({ id: 's1', projectId: 'proj-1', sprint: 'sp-1' });
    expect(mutateAsyncMock).toHaveBeenCalledWith({ id: 's2', projectId: 'proj-1', sprint: 'sp-1' });
    expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining('2 stories'));
  });

  it('keeps only the failed rows selected and leaves the modal open on a partial commit failure', async () => {
    const user = userEvent.setup();
    mutateAsyncMock.mockImplementation(({ id }: { id: string }) =>
      id === 's2' ? Promise.reject(new Error('network error')) : Promise.resolve({}),
    );
    const onClose = vi.fn();
    renderModal({ onClose });
    await user.click(screen.getByRole('button', { name: 'Ready story A' }));
    await user.click(screen.getByRole('button', { name: 'Ready story B' }));
    await user.click(screen.getByRole('button', { name: /Commit 2 stories/i }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
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
