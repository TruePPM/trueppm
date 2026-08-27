import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import type { TrashedTask, TrashedTasksResponse } from '@/hooks/useTaskMutations';

// ---------------------------------------------------------------------------
// Mocks — the trash query + restore mutation + toast. useFocusTrap is stubbed to
// a bare ref so the trap's document listeners don't run in jsdom.
// ---------------------------------------------------------------------------

interface MockQuery {
  data: TrashedTasksResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: ReturnType<typeof vi.fn>;
}

type RestoreMutate = (
  id: string,
  opts: { onSuccess: () => void; onError: (e: unknown) => void },
) => void;

const trashSpy = vi.hoisted(() => vi.fn<() => MockQuery>());
const restoreMut = vi.hoisted(() => ({
  mutate: vi.fn<RestoreMutate>(),
  isPending: false,
  variables: undefined as string | undefined,
}));
const toastSpies = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

// Spread the real module: the dialog also imports `restoreRefusalMessage` from it, and a
// stubbed one would only assert that the test's own stub was called.
vi.mock('@/hooks/useTaskMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useTaskMutations')>();
  return {
    ...actual,
    useTrashedTasks: () => trashSpy(),
    useRestoreTask: () => restoreMut,
  };
});
vi.mock('@/components/Toast', () => ({ toast: toastSpies }));
vi.mock('@/hooks/useFocusTrap', () => ({ useFocusTrap: () => ({ current: null }) }));

const { TaskTrashDialog } = await import('./TaskTrashDialog');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function row(over: Partial<TrashedTask> = {}): TrashedTask {
  return {
    id: 't1',
    name: 'Pour foundation',
    wbs_path: '1.2',
    type: 'TASK',
    status: 'TODO',
    deleted_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    days_remaining: 87,
    retention_days: 90,
    subtree_count: 0,
    can_restore: true,
    ...over,
  };
}

function setTrash(results: TrashedTask[], over: Partial<MockQuery & TrashedTasksResponse> = {}) {
  const { truncated = false, ...queryOver } = over;
  trashSpy.mockReturnValue({
    data: { results, truncated },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    ...queryOver,
  });
}

function render(onClose: () => void = vi.fn()) {
  return renderWithProviders(<TaskTrashDialog projectId="p1" onClose={onClose} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  restoreMut.isPending = false;
  restoreMut.variables = undefined;
  restoreMut.mutate = vi.fn<RestoreMutate>();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

// ---------------------------------------------------------------------------

describe('TaskTrashDialog', () => {
  it('renders a labelled modal dialog', () => {
    setTrash([row()]);
    render();
    const dialog = screen.getByRole('dialog', { name: 'Recently deleted' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('lists a deleted task with its WBS path and how long it stays restorable', () => {
    setTrash([row()]);
    render();
    expect(screen.getByText('Pour foundation')).toBeInTheDocument();
    expect(screen.getByText('1.2')).toBeInTheDocument();
    expect(screen.getByText(/Deleted 3 days ago/)).toBeInTheDocument();
    expect(screen.getByText(/auto-deletes in 87 days/)).toBeInTheDocument();
  });

  it('says how many subtasks come back with a collapsed subtree root', () => {
    setTrash([row({ subtree_count: 4 })]);
    render();
    expect(screen.getByText(/restores 4 subtasks with it/)).toBeInTheDocument();
  });

  it('singularizes the subtask count', () => {
    setTrash([row({ subtree_count: 1 })]);
    render();
    expect(screen.getByText(/restores 1 subtask with it/)).toBeInTheDocument();
  });

  it('reports an indefinite retention for a legacy tombstone with no deleted_at', () => {
    setTrash([row({ deleted_at: null, days_remaining: null })]);
    render();
    expect(screen.getByText(/retained indefinitely/)).toBeInTheDocument();
  });

  it('restores a task and confirms with a toast', () => {
    setTrash([row()]);
    render();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(restoreMut.mutate).toHaveBeenCalledWith('t1', expect.anything());

    // Drive the real onSuccess the component passed in.
    const [, opts] = restoreMut.mutate.mock.calls[0];
    opts.onSuccess();
    expect(toastSpies.success).toHaveBeenCalledWith('"Pour foundation" restored');
  });

  it('surfaces a failed restore as an error toast', () => {
    setTrash([row()]);
    render();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    const [, opts] = restoreMut.mutate.mock.calls[0];
    opts.onError(new Error('boom'));
    expect(toastSpies.error).toHaveBeenCalled();
  });

  it('shows the server sentence when the WBS position is occupied', () => {
    setTrash([row()]);
    render();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    const [, opts] = restoreMut.mutate.mock.calls[0];
    const detail = 'WBS position 3 is now held by "Build". Move that task, then restore this one.';
    opts.onError({
      isAxiosError: true,
      response: { status: 409, data: { code: 'wbs_path_occupied', detail } },
    });
    expect(toastSpies.error).toHaveBeenCalledWith(detail);
  });

  it('disables Restore when the server says the caller may not restore', () => {
    setTrash([row({ can_restore: false })]);
    render();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
  });

  it('does not fire a restore while offline', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    setTrash([row()]);
    render();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(restoreMut.mutate).not.toHaveBeenCalled();
    expect(toastSpies.info).toHaveBeenCalled();
  });

  it('says out loud when the list was capped, rather than implying completeness', () => {
    setTrash([row()], { truncated: true });
    render();
    expect(screen.getByText(/most recent deletions/)).toBeInTheDocument();
  });

  it('omits the cap notice when the list is complete', () => {
    setTrash([row()]);
    render();
    expect(screen.queryByText(/most recent deletions/)).not.toBeInTheDocument();
  });

  it('shows an empty state that also states what is NOT recoverable', () => {
    setTrash([]);
    render();
    expect(screen.getByText('Nothing deleted recently')).toBeInTheDocument();
    expect(screen.getByText(/labels, risks, baselines — are not recoverable/)).toBeInTheDocument();
  });

  it('offers a retry when the list fails to load', () => {
    const refetch = vi.fn();
    trashSpy.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    render();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('closes from the header close button', () => {
    const onClose = vi.fn();
    setTrash([row()]);
    render(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Close recently deleted' }));
    expect(onClose).toHaveBeenCalled();
  });
});
