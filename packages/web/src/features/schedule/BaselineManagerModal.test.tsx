import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { ROLE_ADMIN, ROLE_MEMBER, ROLE_OWNER } from '@/lib/roles';
import type { ApiBaseline } from '@/hooks/useBaselines';

// ---------------------------------------------------------------------------
// Mocks — the five baseline hooks + members + toast. useFocusTrap is stubbed
// to a bare ref so the trap's document listeners don't run in jsdom.
// ---------------------------------------------------------------------------

interface MockList {
  data: ApiBaseline[];
  isLoading: boolean;
  isError: boolean;
  refetch: ReturnType<typeof vi.fn>;
}
interface MockMutation {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
  reset: ReturnType<typeof vi.fn>;
}

const listSpy = vi.hoisted(() => vi.fn<() => MockList>());
const createMut = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false, isError: false, reset: vi.fn() }));
const activateMut = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false, isError: false, reset: vi.fn() }));
const deleteMut = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false, isError: false, reset: vi.fn() }));
const toastSpies = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock('@/hooks/useBaselines', () => ({
  useBaselines: () => listSpy(),
  useCreateBaseline: () => createMut as MockMutation,
  useActivateBaseline: () => activateMut as MockMutation,
  useDeleteBaseline: () => deleteMut as MockMutation,
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

function setList(data: ApiBaseline[], over: Partial<MockList> = {}) {
  listSpy.mockReturnValue({ data, isLoading: false, isError: false, refetch: vi.fn(), ...over });
}

function render(role: number | null) {
  return renderWithProviders(
    <BaselineManagerModal projectId="p1" currentRole={role} onClose={vi.fn()} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  createMut.isPending = false;
  deleteMut.isError = false;
  setList([baseline()]);
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
});
