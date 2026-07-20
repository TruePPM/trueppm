import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PersonalAccessTokensPage } from './PersonalAccessTokensPage';
import type { MyApiToken, CreatedMyApiToken } from '@/hooks/useMyApiTokens';

const useMyApiTokens = vi.fn();
const createMutate = vi.fn();
const revokeMutate = vi.fn();

// Keep the real constant + isTokenActive; only the hooks are stubbed.
vi.mock('@/hooks/useMyApiTokens', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/useMyApiTokens')>();
  return {
    ...actual,
    useMyApiTokens: () => useMyApiTokens() as unknown,
    useCreateMyApiToken: () => ({ mutate: createMutate, isPending: false }),
    useRevokeMyApiToken: () => ({ mutate: revokeMutate, isPending: false }),
  };
});

vi.mock('@/lib/docsUrl', () => ({ docsUrl: (p: string) => `https://docs.example/${p}` }));

function token(overrides: Partial<MyApiToken> = {}): MyApiToken {
  return {
    id: 't1',
    name: 'Power BI export',
    token_prefix: 'tppm_abc',
    scopes: ['legacy:full'],
    created_at: '2026-06-01T00:00:00Z',
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    is_revoked: false,
    is_expired: false,
    ...overrides,
  };
}

beforeEach(() => {
  useMyApiTokens.mockReset();
  createMutate.mockReset();
  revokeMutate.mockReset();
});

describe('PersonalAccessTokensPage', () => {
  it('renders the empty state and a 0-of-10 cap indicator', () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No personal access tokens yet/i)).toBeInTheDocument();
    expect(screen.getByLabelText('0 of 10 active tokens')).toBeInTheDocument();
  });

  it('lists a token with its name and prefix', () => {
    useMyApiTokens.mockReturnValue({
      data: [token()],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Power BI export')).toBeInTheDocument();
    expect(screen.getByText(/tppm_abc/)).toBeInTheDocument();
  });

  it('disables Create when 10 active tokens exist (cap reached)', () => {
    const many = Array.from({ length: 10 }, (_, i) => token({ id: `t${i}`, name: `tok-${i}` }));
    useMyApiTokens.mockReturnValue({
      data: many,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    expect(screen.getByLabelText('10 of 10 active tokens')).toBeInTheDocument();
  });

  it('an expired token does not count toward the active cap', () => {
    const nine = Array.from({ length: 9 }, (_, i) => token({ id: `t${i}`, name: `tok-${i}` }));
    const expired = token({ id: 'exp', name: 'old', is_expired: true });
    useMyApiTokens.mockReturnValue({
      data: [...nine, expired],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled();
    expect(screen.getByLabelText('9 of 10 active tokens')).toBeInTheDocument();
  });

  it('reveals the raw token exactly once after create', async () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    const created: CreatedMyApiToken = { ...token(), token: 'tppm_the_only_reveal' };
    createMutate.mockImplementation(
      (_body: unknown, opts: { onSuccess: (d: CreatedMyApiToken) => void }) => {
        opts.onSuccess(created);
      },
    );
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create personal access token/i });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'My token' } });
    fireEvent.submit(dialog.querySelector('form')!);

    await waitFor(() =>
      expect(screen.getByText(/only time you.*see this token/i)).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('New personal access token')).toHaveValue('tppm_the_only_reveal');
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'My token' }),
      expect.any(Object),
    );
  });

  it('choosing "Read-only for AI assistants" requires an expiry before submit', () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create personal access token/i });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Claude' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Read-only for AI assistants/i }));

    // Submitting without an expiry is blocked client-side (the server also
    // requires it for mcp:read) — the mutation must not fire.
    fireEvent.submit(dialog.querySelector('form')!);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/must expire/i);
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('creating an mcp:read token reveals the claude_desktop_config.json snippet', async () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    const created: CreatedMyApiToken = {
      ...token({ scopes: ['mcp:read'], expires_at: '2027-01-01T23:59:59Z' }),
      token: 'tppm_mcp_reveal_token',
    };
    createMutate.mockImplementation(
      (_body: unknown, opts: { onSuccess: (d: CreatedMyApiToken) => void }) => {
        opts.onSuccess(created);
      },
    );
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create personal access token/i });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Claude' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Read-only for AI assistants/i }));
    fireEvent.change(screen.getByLabelText(/Expiration/i), { target: { value: '2027-01-01' } });
    fireEvent.submit(dialog.querySelector('form')!);

    // The reused McpConnectPanel renders the copy-paste config block.
    await waitFor(() =>
      expect(screen.getByRole('group', { name: /claude_desktop_config\.json snippet/i })).toBeInTheDocument(),
    );
    const snippet = screen.getByRole('group', { name: /claude_desktop_config\.json snippet/i });
    expect(snippet).toHaveTextContent('trueppm-mcp');
    expect(snippet).toHaveTextContent('tppm_mcp_reveal_token');
    expect(screen.getByRole('button', { name: 'Copy config' })).toBeInTheDocument();
    // The mutation carried the read scope.
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Claude', scopes: ['mcp:read'] }),
      expect.any(Object),
    );
  });

  it('revoke opens a confirm dialog and fires the mutation on confirm', () => {
    useMyApiTokens.mockReturnValue({
      data: [token()],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Revoke this token?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke token' }));
    expect(revokeMutate).toHaveBeenCalledWith('t1', expect.any(Object));
  });

  it('renders the loading skeleton while tokens are loading', () => {
    useMyApiTokens.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText('Loading tokens')).toBeInTheDocument();
    // No token list and no empty state while loading.
    expect(screen.queryByText(/No personal access tokens yet/i)).not.toBeInTheDocument();
  });

  it('renders an error state with a Retry that refetches', () => {
    const refetch = vi.fn();
    useMyApiTokens.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't load your tokens/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows Revoked status and hides the Revoke button on a revoked token', () => {
    useMyApiTokens.mockReturnValue({
      data: [token({ is_revoked: true, revoked_at: '2026-06-10T00:00:00Z' })],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('shows Expired status on an expired token', () => {
    useMyApiTokens.mockReturnValue({
      data: [token({ is_expired: true, expires_at: '2026-01-01T00:00:00Z' })],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Expired')).toBeInTheDocument();
    // An expired token shows an "Expired <date>" label from expiryLabel().
    expect(screen.getByText(/Expired /)).toBeInTheDocument();
  });

  it('shows the last-used date and a soon-expiry countdown', () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    useMyApiTokens.mockReturnValue({
      data: [token({ last_used_at: '2026-06-02T00:00:00Z', expires_at: soon })],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Last used /)).toBeInTheDocument();
    // Within 14 days → the "(in N days)" countdown form.
    expect(screen.getByText(/Expires .*\(in \d+ days\)/)).toBeInTheDocument();
  });

  it('shows a plain far-future expiry label without a countdown', () => {
    const far = new Date(Date.now() + 60 * 86_400_000).toISOString();
    useMyApiTokens.mockReturnValue({
      data: [token({ expires_at: far })],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    const expiry = screen.getByText(/^Expires /);
    expect(expiry).toBeInTheDocument();
    expect(expiry.textContent).not.toMatch(/in \d+ days/);
  });

  it('blocks submit and shows a name error when the name is blank', () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create personal access token/i });
    fireEvent.submit(dialog.querySelector('form')!);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/Give the token a name/i);
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('surfaces the server error message when create fails', async () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    createMutate.mockImplementation(
      (_body: unknown, opts: { onError: (e: Error) => void }) => {
        const err = new Error('boom') as Error & { response?: { data?: unknown } };
        err.response = { data: { name: ['A token with this name already exists.'] } };
        opts.onError(err);
      },
    );
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create personal access token/i });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'dupe' } });
    fireEvent.submit(dialog.querySelector('form')!);
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        /A token with this name already exists\./i,
      ),
    );
  });

  it('falls back to a generic error when the failure has no structured body', async () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    createMutate.mockImplementation(
      (_body: unknown, opts: { onError: (e: Error) => void }) => {
        opts.onError(new Error('network'));
      },
    );
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create personal access token/i });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'x' } });
    fireEvent.submit(dialog.querySelector('form')!);
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/Something went wrong/i),
    );
  });

  it('sends an end-of-day ISO expiry when an expiry date is chosen', () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create personal access token/i });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'timed' } });
    fireEvent.change(screen.getByLabelText(/Expiration/i), { target: { value: '2027-03-04' } });
    fireEvent.submit(dialog.querySelector('form')!);
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'timed',
        expires_at: new Date('2027-03-04T23:59:59').toISOString(),
        scopes: ['legacy:full'],
      }),
      expect.any(Object),
    );
  });

  it('closes the create dialog via Cancel without minting a token', () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create personal access token/i });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('Escape closes the create dialog before a token is revealed', () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect(screen.getByRole('dialog', { name: /Create personal access token/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('copies the revealed token to the clipboard and shows the copied confirmation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    const created: CreatedMyApiToken = { ...token(), token: 'tppm_copy_me' };
    createMutate.mockImplementation(
      (_body: unknown, opts: { onSuccess: (d: CreatedMyApiToken) => void }) => {
        opts.onSuccess(created);
      },
    );
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create personal access token/i });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'copyable' } });
    fireEvent.submit(dialog.querySelector('form')!);

    await waitFor(() => expect(screen.getByLabelText('Copy token')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Copy token'));
    expect(writeText).toHaveBeenCalledWith('tppm_copy_me');
    await waitFor(() => expect(screen.getByText(/Copied ✓/)).toBeInTheDocument());
  });

  it('revoke dialog: Keep token cancels without firing the mutation', () => {
    useMyApiTokens.mockReturnValue({
      data: [token()],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep token' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(revokeMutate).not.toHaveBeenCalled();
  });

  it('Escape closes the revoke confirm dialog', () => {
    useMyApiTokens.mockReturnValue({
      data: [token()],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
