import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectedAccountsPage } from './ConnectedAccountsPage';
import type { IntegrationCredentialSummary } from '@/hooks/useIntegrationCredentials';

interface HookReturn {
  credentials: IntegrationCredentialSummary[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => unknown;
}

const useIntegrationCredentials = vi.fn<() => HookReturn>();
const upsertMutate = vi.fn();
const revokeMutate = vi.fn();

vi.mock('@/hooks/useIntegrationCredentials', () => ({
  useIntegrationCredentials: () => useIntegrationCredentials(),
  useUpsertIntegrationCredential: () => ({
    mutate: upsertMutate,
    isPending: false,
    isError: false,
  }),
  useRevokeIntegrationCredential: () => ({
    mutate: revokeMutate,
    isPending: false,
  }),
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/me/settings/connected-accounts']}>
        <ConnectedAccountsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const EMPTY_LIST = [
  {
    provider: 'gitlab',
    name: 'GitLab',
    exists: false,
    base_url: '',
    created_at: null,
    updated_at: null,
    last_used_at: null,
    expires_at: null,
    requires_credential: true,
  },
  {
    provider: 'github',
    name: 'GitHub',
    exists: false,
    base_url: '',
    created_at: null,
    updated_at: null,
    last_used_at: null,
    expires_at: null,
    requires_credential: true,
  },
  {
    provider: 'generic',
    name: 'Generic',
    exists: false,
    base_url: '',
    created_at: null,
    updated_at: null,
    last_used_at: null,
    expires_at: null,
    requires_credential: false,
  },
];

beforeEach(() => {
  upsertMutate.mockReset();
  revokeMutate.mockReset();
});

describe('ConnectedAccountsPage', () => {
  it('renders skeleton while loading', () => {
    useIntegrationCredentials.mockReturnValue({
      credentials: [],
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByLabelText(/Loading connected accounts/i)).toBeInTheDocument();
  });

  it('renders an error state with retry', () => {
    const refetch = vi.fn();
    useIntegrationCredentials.mockReturnValue({
      credentials: [],
      isLoading: false,
      error: new Error('boom'),
      refetch,
    });
    renderPage();
    expect(screen.getByText(/Couldn't load connected accounts/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('renders one section per provider plus the empty-state hint', () => {
    useIntegrationCredentials.mockReturnValue({
      credentials: EMPTY_LIST,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderPage();
    // One heading per provider.
    expect(screen.getByRole('heading', { name: /GitLab/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /GitHub/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Generic/i })).toBeInTheDocument();
    // Empty-state hint is visible when no providers are connected.
    expect(screen.getByText(/Why connect an account/i)).toBeInTheDocument();
    // Generic provider shows the "no credential needed" copy and no Connect button.
    expect(
      screen.getByText(/No credential needed/i),
    ).toBeInTheDocument();
  });

  it('opens connect dialog and submits an upsert', async () => {
    useIntegrationCredentials.mockReturnValue({
      credentials: EMPTY_LIST,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderPage();
    const connectButtons = screen.getAllByRole('button', { name: /^Connect$/ });
    // GitLab is the first provider; click its Connect.
    fireEvent.click(connectButtons[0]);
    const tokenInput = await screen.findByLabelText(/Personal access token/i);
    fireEvent.change(tokenInput, { target: { value: 'glpat-fake' } });
    // The dialog's submit button shares the "Connect" label with the unconnected
    // sections in the page background; scope the click to the dialog.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Connect$/ }));
    await waitFor(() =>
      expect(upsertMutate).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'gitlab', secret: 'glpat-fake' }),
        expect.any(Object),
      ),
    );
  });

  it('shows Rotate + Revoke buttons when a credential exists', () => {
    useIntegrationCredentials.mockReturnValue({
      credentials: [
        {
          ...EMPTY_LIST[1],
          exists: true,
          base_url: 'https://github.example.com',
          created_at: '2026-04-15T10:00:00Z',
          updated_at: '2026-04-15T10:00:00Z',
          last_used_at: '2026-05-20T14:00:00Z',
        },
        EMPTY_LIST[0],
        EMPTY_LIST[2],
      ],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    const { container } = renderPage();
    const githubCard = container.querySelector('#provider-github');
    expect(githubCard).not.toBeNull();
    const card = within(githubCard as HTMLElement);
    expect(card.getByText('Connected')).toBeInTheDocument();
    expect(card.getByRole('button', { name: /Rotate/i })).toBeInTheDocument();
    expect(card.getByRole('button', { name: /Revoke/i })).toBeInTheDocument();
    expect(card.getByText(/https:\/\/github\.example\.com/)).toBeInTheDocument();
  });

  it('confirms revoke before deleting', async () => {
    useIntegrationCredentials.mockReturnValue({
      credentials: [
        {
          ...EMPTY_LIST[1],
          exists: true,
          created_at: '2026-04-15T10:00:00Z',
        },
        EMPTY_LIST[0],
        EMPTY_LIST[2],
      ],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    const { container } = renderPage();
    const githubCard = container.querySelector('#provider-github') as HTMLElement;
    const card = within(githubCard);
    fireEvent.click(card.getByRole('button', { name: /Revoke/i }));
    expect(
      await screen.findByText(/Revoke GitHub credential\?/i),
    ).toBeInTheDocument();
    // Cancelling the dialog should not call revoke.
    fireEvent.click(screen.getByRole('button', { name: /Keep credential/i }));
    expect(revokeMutate).not.toHaveBeenCalled();
    // Re-opening and confirming should call revoke with the correct provider.
    fireEvent.click(card.getByRole('button', { name: /Revoke/i }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Revoke$/ }));
    await waitFor(() =>
      expect(revokeMutate).toHaveBeenCalledWith(
        { provider: 'github' },
        expect.any(Object),
      ),
    );
  });

  it('exposes a hash anchor target per provider', () => {
    useIntegrationCredentials.mockReturnValue({
      credentials: EMPTY_LIST,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    const { container } = renderPage();
    expect(container.querySelector('#provider-gitlab')).not.toBeNull();
    expect(container.querySelector('#provider-github')).not.toBeNull();
    expect(container.querySelector('#provider-generic')).not.toBeNull();
  });
});
