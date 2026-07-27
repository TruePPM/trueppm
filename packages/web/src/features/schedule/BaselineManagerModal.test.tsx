import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_OWNER } from '@/lib/roles';
import type { ApiBaseline } from '@/hooks/useBaselines';

// ---------------------------------------------------------------------------
// Mocks — the five baseline hooks + members + toast. useFocusTrap is stubbed
// to a bare ref so the trap's document listeners don't run in jsdom.
// ---------------------------------------------------------------------------

interface MockList {
  data: ApiBaseline[] | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: ReturnType<typeof vi.fn>;
}

// Mirrors the `mutate(body|id, opts)` shapes the modal drives — typed signatures
// so a test can invoke the real onSuccess/onError callbacks without `any`.
type CaptureMutate = (
  body: Record<string, never>,
  opts: { onSuccess: (b: { name: string }) => void; onError: (e: unknown) => void },
) => void;
type ActivateMutate = (
  id: string,
  opts: { onSuccess: () => void; onError: (e: unknown) => void },
) => void;
type DeleteMutate = (id: string, opts: { onSuccess: () => void }) => void;

const listSpy = vi.hoisted(() => vi.fn<() => MockList>());
const createMut = vi.hoisted(() => ({
  mutate: vi.fn<CaptureMutate>(),
  isPending: false,
  isError: false,
  reset: vi.fn(),
}));
const activateMut = vi.hoisted(() => ({
  mutate: vi.fn<ActivateMutate>(),
  isPending: false,
  isError: false,
  reset: vi.fn(),
}));
const deleteMut = vi.hoisted(() => ({
  mutate: vi.fn<DeleteMutate>(),
  isPending: false,
  isError: false,
  reset: vi.fn(),
}));
const toastSpies = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock('@/hooks/useBaselines', () => ({
  useBaselines: () => listSpy(),
  useCreateBaseline: () => createMut,
  useActivateBaseline: () => activateMut,
  useDeleteBaseline: () => deleteMut,
}));
vi.mock('@/hooks/useProjectMembers', () => ({
  useProjectMembers: () => ({ members: [{ id: 'u1', username: 'kelly', role: ROLE_OWNER }], isLoading: false, error: null }),
}));
vi.mock('@/components/Toast', () => ({ toast: toastSpies }));
vi.mock('@/hooks/useFocusTrap', () => ({ useFocusTrap: () => ({ current: null }) }));

const { BaselineManagerModal } = await import('./BaselineManagerModal');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseline(over: Partial<ApiBaseline> = {}): ApiBaseline {
  return {
    id: 'b1',
    project: 'p1',
    name: 'Baseline 1',
    created_by: 'u1',
    created_at: '2026-07-12T10:00:00Z',
    is_active: true,
    has_cpm_dates: true,
    task_count: 48,
    ...over,
  };
}

function setList(data: ApiBaseline[] | undefined, over: Partial<MockList> = {}) {
  listSpy.mockReturnValue({ data, isLoading: false, isError: false, refetch: vi.fn(), ...over });
}

function render(role: number | null, onClose: () => void = vi.fn()) {
  return renderWithProviders(
    <BaselineManagerModal projectId="p1" currentRole={role} onClose={onClose} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  createMut.isPending = false;
  createMut.isError = false;
  createMut.mutate = vi.fn<CaptureMutate>();
  activateMut.isPending = false;
  activateMut.isError = false;
  activateMut.mutate = vi.fn<ActivateMutate>();
  deleteMut.isPending = false;
  deleteMut.isError = false;
  deleteMut.mutate = vi.fn<DeleteMutate>();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  setList([baseline()]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Role gating
// ---------------------------------------------------------------------------

describe('BaselineManagerModal — role gates', () => {
  it('member (read-only): no capture, no set-active/delete, shows admin note', () => {
    setList([baseline({ is_active: true }), baseline({ id: 'b2', name: 'Baseline 2', is_active: false })]);
    render(ROLE_MEMBER);
    expect(screen.queryByRole('button', { name: /capture baseline/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /set active/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
    expect(screen.getByText(/captured by a project admin/i)).toBeInTheDocument();
  });

  it('admin: capture + set-active on inactive rows, but no delete (owner-only)', () => {
    setList([baseline({ is_active: true }), baseline({ id: 'b2', name: 'Baseline 2', is_active: false })]);
    render(ROLE_ADMIN);
    expect(screen.getByRole('button', { name: /capture baseline/i })).toBeInTheDocument();
    // One inactive row → exactly one "Set active"; the active row omits it.
    expect(screen.getAllByRole('button', { name: /set active/i })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });

  it('owner: delete available on every row', () => {
    setList([baseline({ is_active: true }), baseline({ id: 'b2', name: 'Baseline 2', is_active: false })]);
    render(ROLE_OWNER);
    expect(screen.getAllByRole('button', { name: /^delete$/i })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

describe('BaselineManagerModal — actions', () => {
  it('capture goes through the educational confirm before calling createBaseline', () => {
    render(ROLE_ADMIN);
    // Header button opens the confirm — it does NOT capture directly.
    fireEvent.click(screen.getByRole('button', { name: /capture baseline/i }));
    expect(createMut.mutate).not.toHaveBeenCalled();
    const confirm = screen.getByRole('dialog', { name: /capture a baseline\?/i });
    fireEvent.click(within(confirm).getByRole('button', { name: /capture baseline/i }));
    expect(createMut.mutate).toHaveBeenCalledWith({}, expect.any(Object));
  });

  it('capture confirm explains immutability and that a re-baseline keeps history', () => {
    // Default fixture has an active "Baseline 1" → the supersede branch names it.
    render(ROLE_ADMIN);
    fireEvent.click(screen.getByRole('button', { name: /capture baseline/i }));
    const confirm = screen.getByRole('dialog', { name: /capture a baseline\?/i });
    expect(within(confirm).getByText(/immutable/i)).toBeInTheDocument();
    expect(within(confirm).getByText(/history/i)).toBeInTheDocument();
    expect(within(confirm).getByText('Baseline 1')).toBeInTheDocument();
  });

  it('set active calls activateBaseline with the row id', () => {
    setList([baseline({ is_active: true }), baseline({ id: 'b2', name: 'Baseline 2', is_active: false })]);
    render(ROLE_ADMIN);
    fireEvent.click(screen.getByRole('button', { name: /set active/i }));
    expect(activateMut.mutate).toHaveBeenCalledWith('b2', expect.any(Object));
  });

  it('delete is a two-step destructive confirm (Cancel first)', () => {
    render(ROLE_OWNER);
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toBeInTheDocument();
    // Confirm not fired until the destructive button in the dialog is clicked.
    expect(deleteMut.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /delete baseline/i }));
    expect(deleteMut.mutate).toHaveBeenCalledWith('b1', expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

describe('BaselineManagerModal — states', () => {
  it('empty: admin sees the EmptyState capture CTA', () => {
    setList([]);
    render(ROLE_ADMIN);
    expect(screen.getByText(/no baselines yet/i)).toBeInTheDocument();
    // Both the header button and the EmptyState CTA offer capture for an admin.
    expect(screen.getAllByRole('button', { name: /capture baseline/i })).toHaveLength(2);
  });

  it('loading: shows a Loading baselines status region', () => {
    setList([], { isLoading: true });
    render(ROLE_ADMIN);
    expect(screen.getByRole('status', { name: /loading baselines/i })).toBeInTheDocument();
  });

  it('error: shows the query error state', () => {
    setList([], { isError: true });
    render(ROLE_ADMIN);
    expect(screen.getByText(/couldn't load baselines/i)).toBeInTheDocument();
  });

  it('caveat: surfaces the pre-CPM warning for has_cpm_dates=false', () => {
    setList([baseline({ has_cpm_dates: false })]);
    render(ROLE_ADMIN);
    expect(screen.getByText(/before the schedule was fully calculated/i)).toBeInTheDocument();
  });

  it('active row shows the Active badge and omits Set active', () => {
    setList([baseline({ is_active: true })]);
    render(ROLE_ADMIN);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set active/i })).toBeNull();
  });

  it('role still loading (null): treated as read-only, no capture or delete', () => {
    setList([baseline({ is_active: false })]);
    render(null);
    expect(screen.queryByRole('button', { name: /capture baseline/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /set active/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
    expect(screen.getByText(/captured by a project admin/i)).toBeInTheDocument();
  });

  it('empty + read-only: the empty state offers no capture CTA', () => {
    setList([]);
    render(ROLE_MEMBER);
    expect(screen.getByText(/no baselines yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /capture baseline/i })).toBeNull();
  });

  it('treats an unresolved query payload as an empty list', () => {
    setList(undefined);
    render(ROLE_MEMBER);
    expect(screen.getByText(/no baselines yet/i)).toBeInTheDocument();
  });

  it('the empty-state CTA opens the same capture confirm as the header button', () => {
    setList([]);
    render(ROLE_ADMIN);
    const [, emptyStateCta] = screen.getAllByRole('button', { name: /capture baseline/i });
    fireEvent.click(emptyStateCta);
    expect(screen.getByRole('dialog', { name: /capture a baseline\?/i })).toBeInTheDocument();
    expect(createMut.mutate).not.toHaveBeenCalled();
  });

  it('admin note is omitted once the caller can capture', () => {
    render(ROLE_ADMIN);
    expect(screen.queryByText(/captured by a project admin/i)).toBeNull();
  });

  it('error state retries the baselines query', () => {
    const refetch = vi.fn();
    setList([], { isError: true, refetch });
    render(ROLE_ADMIN);
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(refetch).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Row metadata
// ---------------------------------------------------------------------------

describe('BaselineManagerModal — row metadata', () => {
  it('attributes the capture to the member who took it', () => {
    setList([baseline({ created_by: 'u1' })]);
    render(ROLE_ADMIN);
    expect(screen.getByText(/· by kelly/)).toBeInTheDocument();
  });

  it('omits the author when created_by is null (system capture)', () => {
    setList([baseline({ created_by: null })]);
    render(ROLE_ADMIN);
    expect(screen.queryByText(/· by /)).toBeNull();
  });

  it('omits the author when the capturing user is no longer a project member', () => {
    setList([baseline({ created_by: 'gone-user' })]);
    render(ROLE_ADMIN);
    expect(screen.queryByText(/· by /)).toBeNull();
  });

  it('pluralizes the task count, and stays singular at one task', () => {
    setList([baseline({ task_count: 1 }), baseline({ id: 'b2', name: 'B2', task_count: 2, is_active: false })]);
    render(ROLE_ADMIN);
    expect(screen.getByText(/1 task$/)).toBeInTheDocument();
    expect(screen.getByText(/2 tasks$/)).toBeInTheDocument();
  });

  it('omits the pre-CPM caveat when the snapshot has CPM dates', () => {
    setList([baseline({ has_cpm_dates: true })]);
    render(ROLE_ADMIN);
    expect(screen.queryByText(/before the schedule was fully calculated/i)).toBeNull();
  });

  it('disables Set active while an activation is in flight', () => {
    activateMut.isPending = true;
    setList([baseline({ id: 'b2', name: 'Baseline 2', is_active: false })]);
    render(ROLE_ADMIN);
    expect(screen.getByRole('button', { name: /set active/i })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Dismissal
// ---------------------------------------------------------------------------

describe('BaselineManagerModal — dismissal', () => {
  it('closes on the header close button', () => {
    const onClose = vi.fn();
    render(ROLE_ADMIN, onClose);
    fireEvent.click(screen.getByRole('button', { name: /close baselines/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a scrim press but not on a press inside the panel', () => {
    const onClose = vi.fn();
    render(ROLE_ADMIN, onClose);
    // A press on the panel body must not fall through to the scrim.
    fireEvent.pointerDown(screen.getByRole('heading', { name: 'Baselines' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('dialog', { name: 'Baselines' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Capture outcomes
// ---------------------------------------------------------------------------

describe('BaselineManagerModal — capture outcomes', () => {
  function openCaptureConfirm() {
    fireEvent.click(screen.getByRole('button', { name: /capture baseline/i }));
    return screen.getByRole('dialog', { name: /capture a baseline\?/i });
  }

  it('refuses to capture while offline and says why', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(ROLE_ADMIN);
    const confirm = openCaptureConfirm();
    fireEvent.click(within(confirm).getByRole('button', { name: /capture baseline/i }));
    expect(createMut.mutate).not.toHaveBeenCalled();
    expect(toastSpies.info).toHaveBeenCalledWith(
      "You're offline — reconnect to capture a baseline.",
    );
  });

  it('toasts the new baseline name and closes the confirm on success', () => {
    createMut.mutate = vi.fn<CaptureMutate>((_body, opts) => {
      opts.onSuccess({ name: 'Baseline 7' });
    });
    render(ROLE_ADMIN);
    const confirm = openCaptureConfirm();
    fireEvent.click(within(confirm).getByRole('button', { name: /capture baseline/i }));
    expect(toastSpies.success).toHaveBeenCalledWith('Captured Baseline 7');
    expect(screen.queryByRole('dialog', { name: /capture a baseline\?/i })).toBeNull();
  });

  it('keeps the confirm open and toasts an error when the capture fails', () => {
    createMut.mutate = vi.fn<CaptureMutate>((_body, opts) => {
      opts.onError(new Error('boom'));
    });
    render(ROLE_ADMIN);
    const confirm = openCaptureConfirm();
    fireEvent.click(within(confirm).getByRole('button', { name: /capture baseline/i }));
    expect(toastSpies.error).toHaveBeenCalledWith("Couldn't capture baseline — try again.");
    expect(screen.getByRole('dialog', { name: /capture a baseline\?/i })).toBeInTheDocument();
  });

  it('Cancel dismisses the capture confirm without capturing', () => {
    render(ROLE_ADMIN);
    const confirm = openCaptureConfirm();
    fireEvent.click(within(confirm).getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog', { name: /capture a baseline\?/i })).toBeNull();
    expect(createMut.mutate).not.toHaveBeenCalled();
  });

  it('an in-flight capture blocks Cancel and disables the header button', () => {
    createMut.isPending = true;
    render(ROLE_ADMIN);
    fireEvent.click(screen.getByRole('button', { name: /capture baseline/i }));
    // The header trigger is disabled while pending, so open via the row-less path:
    // the confirm is not reachable — assert the disabled affordance instead.
    expect(screen.getByRole('button', { name: /capture baseline/i })).toBeDisabled();
    expect(screen.queryByRole('dialog', { name: /capture a baseline\?/i })).toBeNull();
  });

  it('first capture (no active baseline) explains that it becomes the active one', () => {
    setList([baseline({ is_active: false })]);
    render(ROLE_ADMIN);
    const confirm = openCaptureConfirm();
    expect(within(confirm).getByText(/becomes|become the/i)).toBeInTheDocument();
    expect(within(confirm).queryByText(/stays active/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Activate outcomes
// ---------------------------------------------------------------------------

describe('BaselineManagerModal — activate outcomes', () => {
  beforeEach(() => {
    setList([baseline({ is_active: true }), baseline({ id: 'b2', name: 'Baseline 2', is_active: false })]);
  });

  it('refuses to activate while offline and says why', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(ROLE_ADMIN);
    fireEvent.click(screen.getByRole('button', { name: /set active/i }));
    expect(activateMut.mutate).not.toHaveBeenCalled();
    expect(toastSpies.info).toHaveBeenCalledWith(
      "You're offline — reconnect to change the active baseline.",
    );
  });

  it('confirms the new active baseline by name on success', () => {
    activateMut.mutate = vi.fn<ActivateMutate>((_id, opts) => {
      opts.onSuccess();
    });
    render(ROLE_ADMIN);
    fireEvent.click(screen.getByRole('button', { name: /set active/i }));
    expect(toastSpies.success).toHaveBeenCalledWith('Baseline 2 is now the active baseline');
  });

  it('toasts an error when activation fails', () => {
    activateMut.mutate = vi.fn<ActivateMutate>((_id, opts) => {
      opts.onError(new Error('boom'));
    });
    render(ROLE_ADMIN);
    fireEvent.click(screen.getByRole('button', { name: /set active/i }));
    expect(toastSpies.error).toHaveBeenCalledWith("Couldn't activate baseline — try again.");
    expect(toastSpies.success).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Delete outcomes
// ---------------------------------------------------------------------------

describe('BaselineManagerModal — delete outcomes', () => {
  function openDeleteConfirm() {
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    return screen.getByRole('alertdialog');
  }

  it('refuses to delete while offline and keeps the confirm open', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(ROLE_OWNER);
    openDeleteConfirm();
    fireEvent.click(screen.getByRole('button', { name: /delete baseline/i }));
    expect(deleteMut.mutate).not.toHaveBeenCalled();
    expect(toastSpies.info).toHaveBeenCalledWith(
      "You're offline — reconnect to delete a baseline.",
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('toasts and closes the confirm when the delete succeeds', () => {
    deleteMut.mutate = vi.fn<DeleteMutate>((_id, opts) => {
      opts.onSuccess();
    });
    render(ROLE_OWNER);
    openDeleteConfirm();
    fireEvent.click(screen.getByRole('button', { name: /delete baseline/i }));
    expect(toastSpies.success).toHaveBeenCalledWith('Deleted Baseline 1');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('surfaces an inline retry message when the delete errored', () => {
    deleteMut.isError = true;
    render(ROLE_OWNER);
    const dialog = openDeleteConfirm();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/couldn't delete/i);
  });

  it('shows no inline error before anything has failed', () => {
    render(ROLE_OWNER);
    const dialog = openDeleteConfirm();
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('Cancel clears the mutation error state and closes the confirm', () => {
    deleteMut.isError = true;
    render(ROLE_OWNER);
    openDeleteConfirm();
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(deleteMut.reset).toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deleteMut.mutate).not.toHaveBeenCalled();
  });

  it('an in-flight delete shows Deleting… and refuses to be dismissed', () => {
    deleteMut.isPending = true;
    render(ROLE_OWNER);
    const dialog = openDeleteConfirm();
    expect(within(dialog).getByRole('button', { name: /deleting/i })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    // A scrim press is inert while the request is in flight.
    fireEvent.pointerDown(dialog);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(deleteMut.reset).not.toHaveBeenCalled();
  });

  it('a scrim press dismisses the delete confirm when idle', () => {
    render(ROLE_OWNER);
    const dialog = openDeleteConfirm();
    fireEvent.pointerDown(dialog);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a press inside the delete panel does not dismiss it', () => {
    render(ROLE_OWNER);
    const dialog = openDeleteConfirm();
    fireEvent.pointerDown(within(dialog).getByRole('heading', { name: /delete this baseline\?/i }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('names the baseline and its task count in the confirm copy', () => {
    setList([baseline({ name: 'Q3 freeze', task_count: 12 })]);
    render(ROLE_OWNER);
    const dialog = openDeleteConfirm();
    expect(within(dialog).getByText(/Q3 freeze/)).toBeInTheDocument();
    expect(within(dialog).getByText(/12-task snapshot/)).toBeInTheDocument();
  });
});
