import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TrashProject } from '@/hooks/useProjectMutations';
import { WorkspaceTrashPage } from './WorkspaceTrashPage';

// Isolate the Trash list logic from the settings shell chrome.
vi.mock('../SettingsShell', () => ({
  SettingsShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsPageTitle: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

// The shell reads the workspace name for its context pill (#2013); stub the
// query hook so the test doesn't need a QueryClientProvider.
vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => ({ data: { name: 'TrueScope' }, isLoading: false }),
}));

const restoreMutate = vi.fn<(id: string, opts?: { onSuccess?: () => void }) => void>();
let restoreState = {
  mutate: restoreMutate,
  isPending: false,
  isError: false,
  error: null as Error | null,
  variables: undefined as string | undefined,
};
let trashState: {
  data: TrashProject[] | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} = { data: [], isLoading: false, isError: false, refetch: vi.fn() };

vi.mock('@/hooks/useProjectMutations', () => ({
  useTrashedProjects: () => trashState,
  useRestoreProject: () => restoreState,
}));

const toastSuccess = vi.fn();
vi.mock('@/components/Toast', () => ({
  toast: {
    success: (m: string) => {
      toastSuccess(m);
    },
  },
}));

function row(overrides: Partial<TrashProject> = {}): TrashProject {
  return {
    id: 'p-1',
    name: 'Downtown Retrofit',
    code: 'DTR',
    deleted_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    deleted_by: 'u-2',
    deleted_by_name: 'Sarah Chen',
    days_remaining: 27,
    retention_days: 30,
    my_role: 400,
    can_restore: true,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <WorkspaceTrashPage />
    </MemoryRouter>,
  );
}

describe('WorkspaceTrashPage (#1113)', () => {
  beforeEach(() => {
    restoreMutate.mockReset();
    toastSuccess.mockReset();
    restoreState = { mutate: restoreMutate, isPending: false, isError: false, error: null, variables: undefined };
    trashState = { data: [], isLoading: false, isError: false, refetch: vi.fn() };
  });

  it('shows the empty state when Trash has no projects', () => {
    renderPage();
    expect(screen.getByText('Trash is empty')).toBeInTheDocument();
  });

  it('renders a trashed project with its metadata and an enabled Restore for an Owner', () => {
    trashState = { ...trashState, data: [row()] };
    renderPage();
    expect(screen.getByText('Downtown Retrofit')).toBeInTheDocument();
    expect(screen.getByText('DTR')).toBeInTheDocument();
    expect(screen.getByText(/Deleted by Sarah Chen/)).toBeInTheDocument();
    expect(screen.getByText(/auto-deletes in 27 days/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled();
  });

  it('restores a project on click and confirms with a success toast', async () => {
    const user = userEvent.setup();
    trashState = { ...trashState, data: [row()] };
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(restoreMutate).toHaveBeenCalledTimes(1);
    const [id, opts] = restoreMutate.mock.calls[0];
    expect(id).toBe('p-1');
    expect(opts?.onSuccess).toBeTypeOf('function');
    // Fire the onSuccess the component passed, as the mutation would on 200.
    opts?.onSuccess?.();
    expect(toastSuccess).toHaveBeenCalledWith('"Downtown Retrofit" restored');
  });

  it('disables Restore for a non-Owner member with an explanatory tooltip', () => {
    trashState = { ...trashState, data: [row({ can_restore: false, my_role: 100 })] };
    renderPage();
    const btn = screen.getByRole('button', { name: 'Restore' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Only the project Owner can restore this project.');
  });

  it('shows an indefinite-retention row for a legacy null deleted_at', () => {
    trashState = { ...trashState, data: [row({ deleted_at: null, days_remaining: null })] };
    renderPage();
    expect(screen.getByText(/retained indefinitely/)).toBeInTheDocument();
    expect(screen.queryByText(/auto-deletes in/)).not.toBeInTheDocument();
  });

  it('renders the error state with a Retry when the list fails to load', () => {
    trashState = { data: undefined, isLoading: false, isError: true, refetch: vi.fn() };
    renderPage();
    expect(screen.getByText("Couldn't load Trash.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
