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

// The "Available sources" section (#1420/#1421) reads each source's connection
// state + cached items through these hooks and writes through the connect / sync
// / disconnect mutations. Mock the whole module so the section renders
// deterministically without touching apiClient; the dedicated section tests below
// drive each hook per-state.
import type { ExternalWorkItem } from '@/hooks/useExternalConnection';

interface ConnReturn {
  connection: {
    account_email: string;
    base_url?: string;
    status?: string;
    last_synced_at: string | null;
  } | null;
  isConnected: boolean;
  isLoading: boolean;
}
const useExternalConnection = vi.fn<(source: string, enabled?: boolean) => ConnReturn>();
const useExternalItems = vi.fn<() => { items: ExternalWorkItem[]; isLoading: boolean }>();
const syncMutate = vi.fn();
const disconnectMutate = vi.fn();
const connectMutate = vi.fn();
vi.mock('@/hooks/useExternalConnection', () => ({
  useExternalConnection: (source: string, enabled?: boolean) =>
    useExternalConnection(source, enabled),
  useExternalItems: () => useExternalItems(),
  useSyncExternalSource: () => ({ mutate: syncMutate, isPending: false }),
  useDisconnectExternalSource: () => ({ mutate: disconnectMutate, isPending: false }),
  useConnectExternalSource: () => ({ mutate: connectMutate, isPending: false }),
  extractConnectionError: (_err: unknown, fallback: string) => fallback,
}));

const NOT_CONNECTED: ConnReturn = {
  connection: null,
  isConnected: false,
  isLoading: false,
};

// Relative to test-run time (not a fixed date) so freshness/staleness assertions
// stay correct regardless of when the suite runs — see #1910.
const FIVE_MINUTES_AGO = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

const CONNECTED_JIRA: ConnReturn = {
  connection: {
    account_email: 'p.patel@acme.com',
    base_url: 'https://acme.atlassian.net',
    status: 'connected',
    last_synced_at: FIVE_MINUTES_AGO,
  },
  isConnected: true,
  isLoading: false,
};

const CONNECTED_JIRA_STALE: ConnReturn = {
  connection: {
    account_email: 'p.patel@acme.com',
    base_url: 'https://acme.atlassian.net',
    status: 'connected',
    last_synced_at: THREE_DAYS_AGO,
  },
  isConnected: true,
  isLoading: false,
};

const CONNECTED_JIRA_AUTH_FAILED: ConnReturn = {
  connection: {
    account_email: 'p.patel@acme.com',
    base_url: 'https://acme.atlassian.net',
    status: 'auth_failed',
    last_synced_at: THREE_DAYS_AGO,
  },
  isConnected: true,
  isLoading: false,
};

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
  syncMutate.mockReset();
  disconnectMutate.mockReset();
  connectMutate.mockReset();
  useExternalConnection.mockReset();
  useExternalConnection.mockReturnValue(NOT_CONNECTED);
  useExternalItems.mockReset();
  useExternalItems.mockReturnValue({ items: [], isLoading: false });
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
    // One heading per provider — scoped to the credentials list so the
    // "Available sources" section's own GitHub card doesn't collide (#1420).
    const credentials = within(
      screen.getByRole('list', { name: 'Integration providers' }),
    );
    expect(credentials.getByRole('heading', { name: /GitLab/i })).toBeInTheDocument();
    expect(credentials.getByRole('heading', { name: /GitHub/i })).toBeInTheDocument();
    expect(credentials.getByRole('heading', { name: /Generic/i })).toBeInTheDocument();
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

describe('ConnectedAccountsPage — Available sources (#1420)', () => {
  beforeEach(() => {
    useIntegrationCredentials.mockReturnValue({
      credentials: EMPTY_LIST,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it('renders the section, trust badges, and a card per registry source', () => {
    renderPage();
    expect(
      screen.getByRole('region', { name: /Available sources/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: /Trust guarantees/i }),
    ).toBeInTheDocument();
    const sources = within(
      screen.getByRole('list', { name: 'External task sources' }),
    );
    expect(sources.getByRole('heading', { name: /Jira/i })).toBeInTheDocument();
    expect(sources.getByRole('heading', { name: /GitHub/i })).toBeInTheDocument();
  });

  it('shows Connect on an available source and a gated "Coming soon" on a coming_soon one', () => {
    useExternalConnection.mockReturnValue(NOT_CONNECTED);
    renderPage();
    // jira is available-but-not-connected → an interactive Connect button (#1421).
    const jira = within(document.getElementById('source-jira') as HTMLElement);
    expect(jira.getByRole('button', { name: /^Connect$/ })).toBeInTheDocument();
    // github is coming_soon → non-interactive "Coming soon", never a control.
    const github = within(document.getElementById('source-github') as HTMLElement);
    expect(github.getByText(/Coming soon/i)).toBeInTheDocument();
    expect(github.queryByRole('button')).toBeNull();
    expect(github.queryByRole('link')).toBeNull();
  });

  it('opens the PAT connect wizard from the Connect button', async () => {
    useExternalConnection.mockReturnValue(NOT_CONNECTED);
    renderPage();
    const jira = within(document.getElementById('source-jira') as HTMLElement);
    fireEvent.click(jira.getByRole('button', { name: /^Connect$/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /Connect Jira/i })).toBeInTheDocument();
    // The credential step (not an OAuth redirect) — site URL + email + token.
    expect(within(dialog).getByLabelText(/Site URL/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Account email/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/API token/i)).toBeInTheDocument();
  });

  it('shows "Active", the linked account, and manage actions when connected', () => {
    useExternalConnection.mockImplementation((source: string) =>
      source === 'jira' ? CONNECTED_JIRA : NOT_CONNECTED,
    );
    renderPage();
    const card = within(document.getElementById('source-jira') as HTMLElement);
    expect(card.getByText('Active')).toBeInTheDocument();
    expect(card.getByText(/Linked as p\.patel@acme\.com/i)).toBeInTheDocument();
    // "Manage" collapses inline (ADR-0313): Sync now + Disconnect on the card.
    expect(card.getByRole('button', { name: /Sync now/i })).toBeInTheDocument();
    expect(card.getByRole('button', { name: /^Disconnect$/i })).toBeInTheDocument();
  });

  it('triggers a sync from "Sync now"', () => {
    useExternalConnection.mockImplementation((source: string) =>
      source === 'jira' ? CONNECTED_JIRA : NOT_CONNECTED,
    );
    renderPage();
    const card = within(document.getElementById('source-jira') as HTMLElement);
    fireEvent.click(card.getByRole('button', { name: /Sync now/i }));
    expect(syncMutate).toHaveBeenCalled();
  });

  it('confirms before disconnecting', async () => {
    useExternalConnection.mockImplementation((source: string) =>
      source === 'jira' ? CONNECTED_JIRA : NOT_CONNECTED,
    );
    renderPage();
    const card = within(document.getElementById('source-jira') as HTMLElement);
    // Open the confirm, then cancel — no disconnect call.
    fireEvent.click(card.getByRole('button', { name: /^Disconnect$/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Disconnect Jira\?/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /Keep connected/i }));
    expect(disconnectMutate).not.toHaveBeenCalled();
    // Re-open and confirm.
    fireEvent.click(card.getByRole('button', { name: /^Disconnect$/i }));
    const dialog2 = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog2).getByRole('button', { name: /^Disconnect$/i }));
    expect(disconnectMutate).toHaveBeenCalled();
  });

  it('previews recently-pulled items on the connected card', () => {
    useExternalConnection.mockImplementation((source: string) =>
      source === 'jira' ? CONNECTED_JIRA : NOT_CONNECTED,
    );
    useExternalItems.mockReturnValue({
      items: [
        {
          id: 'i1',
          source_key: 'jira',
          external_id: 'RIV-482',
          external_url: 'https://acme.atlassian.net/browse/RIV-482',
          title: 'API gateway returns 502 under load',
          external_status: 'In progress',
          display_bucket: 'in_progress',
          last_synced_at: '2026-05-20T14:00:00Z',
        },
      ],
      isLoading: false,
    });
    renderPage();
    const card = within(document.getElementById('source-jira') as HTMLElement);
    expect(card.getByText('RIV-482')).toBeInTheDocument();
    expect(card.getByText(/API gateway returns 502/i)).toBeInTheDocument();
    expect(
      card.getByRole('link', { name: /Open RIV-482 in Jira/i }),
    ).toBeInTheDocument();
  });

  it('renders an auth_failed Reconnect banner and reopens the connect flow', async () => {
    useExternalConnection.mockImplementation((source: string) =>
      source === 'jira' ? CONNECTED_JIRA_AUTH_FAILED : NOT_CONNECTED,
    );
    renderPage();
    const card = within(document.getElementById('source-jira') as HTMLElement);
    const banner = card.getByRole('status');
    expect(banner).toHaveTextContent(/needs reauthorization/i);
    expect(banner).toHaveAttribute('aria-live', 'polite');

    // A stale last_synced_at is also true on this fixture, but the auth_failed
    // banner takes precedence — no separate staleness note.
    expect(card.queryByText(/^Last synced/i)).not.toBeInTheDocument();

    // "Reconnect" reuses the same PAT wizard as the initial Connect — no new flow.
    fireEvent.click(card.getByRole('button', { name: 'Reconnect' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /Connect Jira/i })).toBeInTheDocument();
  });

  it('shows a quiet "Last synced … ago" note for a stale connection', () => {
    useExternalConnection.mockImplementation((source: string) =>
      source === 'jira' ? CONNECTED_JIRA_STALE : NOT_CONNECTED,
    );
    renderPage();
    const card = within(document.getElementById('source-jira') as HTMLElement);
    expect(card.getByText(/^Last synced 3d ago$/)).toBeInTheDocument();
    expect(card.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders neither banner nor staleness note for a healthy, fresh connection', () => {
    useExternalConnection.mockImplementation((source: string) =>
      source === 'jira' ? CONNECTED_JIRA : NOT_CONNECTED,
    );
    renderPage();
    const card = within(document.getElementById('source-jira') as HTMLElement);
    expect(card.queryByRole('status')).not.toBeInTheDocument();
    expect(card.queryByText(/^Last synced/i)).not.toBeInTheDocument();
    expect(card.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('fetches connection state only for available sources', () => {
    renderPage();
    // jira is available → fetch enabled; github is coming_soon → not fetched.
    expect(useExternalConnection).toHaveBeenCalledWith('jira', true);
    expect(useExternalConnection).toHaveBeenCalledWith('github', false);
  });

  it('renders a skeleton (not a status pill) while an available source loads', () => {
    useExternalConnection.mockImplementation((source: string) =>
      source === 'jira'
        ? { connection: null, isConnected: false, isLoading: true }
        : NOT_CONNECTED,
    );
    renderPage();
    const jira = within(document.getElementById('source-jira') as HTMLElement);
    expect(jira.queryByText('Active')).toBeNull();
    expect(jira.queryByText(/Coming soon/i)).toBeNull();
  });

  it('exposes a hash anchor target per source', () => {
    renderPage();
    expect(document.getElementById('source-jira')).not.toBeNull();
    expect(document.getElementById('source-github')).not.toBeNull();
  });
});
