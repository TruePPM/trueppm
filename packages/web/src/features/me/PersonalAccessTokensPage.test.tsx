import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PersonalAccessTokensPage } from './PersonalAccessTokensPage';
import { MCP_INSTALL_COMMAND } from '@/features/settings/components/integrations/McpConnectPanel';
import type { MyApiToken, CreatedMyApiToken } from '@/hooks/useMyApiTokens';

const useMyApiTokens = vi.fn();
const createMutate = vi.fn();
const revokeMutate = vi.fn();
// Driven per-test so the in-flight ("Creating…" / "Revoking…") states are reachable.
let createPending = false;
let revokePending = false;

// Keep the real constant + isTokenActive; only the hooks are stubbed.
vi.mock('@/hooks/useMyApiTokens', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/useMyApiTokens')>();
  return {
    ...actual,
    useMyApiTokens: () => useMyApiTokens() as unknown,
    useCreateMyApiToken: () => ({ mutate: createMutate, isPending: createPending }),
    useRevokeMyApiToken: () => ({ mutate: revokeMutate, isPending: revokePending }),
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
  createPending = false;
  revokePending = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Render the page inside a router (it hosts `MeSettingsSubNav`'s NavLinks). */
function renderPage() {
  return render(
    <MemoryRouter>
      <PersonalAccessTokensPage />
    </MemoryRouter>,
  );
}

/** Open the create dialog and fill in a name; returns the dialog element. */
function openCreateDialog(name = 'My token'): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
  const dialog = screen.getByRole('dialog', { name: /Create personal access token/i });
  if (name) fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: name } });
  return dialog;
}

/** Make the create mutation succeed with `created`. */
function createSucceedsWith(created: CreatedMyApiToken) {
  createMutate.mockImplementation(
    (_body: unknown, opts: { onSuccess: (d: CreatedMyApiToken) => void }) => {
      opts.onSuccess(created);
    },
  );
}

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

    // #2890: the config invokes a `trueppm-mcp` executable, so the panel has to
    // say how to get one. Without this step, "add this and restart" ends in
    // command-not-found on the restart, outside the app where nothing explains it.
    const install = screen.getByRole('group', { name: /install command/i });
    expect(install).toHaveTextContent(MCP_INSTALL_COMMAND);
    expect(screen.getByRole('button', { name: 'Copy install command' })).toBeInTheDocument();
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
    // The confirmation check is a house CheckIcon SVG, not a "✓" glyph (issue 1749),
    // so assert the button's text flip rather than the old glyph-bearing string.
    await waitFor(() => expect(screen.getByLabelText('Copy token')).toHaveTextContent('Copied'));
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

  // -------------------------------------------------------------------------
  // Cap indicator
  // -------------------------------------------------------------------------

  it('explains why Create is disabled at the cap and drops the hint below it', () => {
    const many = Array.from({ length: 10 }, (_, i) => token({ id: `t${i}`, name: `tok-${i}` }));
    useMyApiTokens.mockReturnValue({
      data: many,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    const { rerender } = renderPage();
    expect(screen.getByRole('button', { name: 'Create token' })).toHaveAttribute(
      'title',
      'Revoke a token to free up a slot',
    );
    expect(screen.getByLabelText('10 of 10 active tokens')).toHaveTextContent(
      /revoke one to create another/i,
    );

    // Below the cap the hint disappears and the button carries no explanatory title.
    useMyApiTokens.mockReturnValue({
      data: many.slice(0, 5),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    rerender(
      <MemoryRouter>
        <PersonalAccessTokensPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Create token' })).not.toHaveAttribute('title');
    expect(screen.getByLabelText('5 of 10 active tokens')).not.toHaveTextContent(
      /revoke one to create another/i,
    );
  });

  // -------------------------------------------------------------------------
  // Create dialog — dismissal guards around the one-time reveal
  // -------------------------------------------------------------------------

  it('clicking the create dialog scrim closes it, but clicking the panel does not', () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    renderPage();
    const dialog = openCreateDialog('');

    // Pointer-down inside the panel must not dismiss (target !== currentTarget).
    fireEvent.pointerDown(dialog.firstElementChild!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Pointer-down on the scrim itself dismisses.
    fireEvent.pointerDown(dialog);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the scrim does not dismiss the dialog once the raw token is revealed', async () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    createSucceedsWith({ ...token(), token: 'tppm_unrecoverable' });
    renderPage();
    const dialog = openCreateDialog('irreversible');
    fireEvent.submit(dialog.querySelector('form')!);
    await waitFor(() =>
      expect(screen.getByLabelText('New personal access token')).toBeInTheDocument(),
    );

    // Neither the scrim nor Escape may discard a token the user hasn't copied yet.
    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(screen.getByLabelText('New personal access token')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByLabelText('New personal access token')).toHaveValue('tppm_unrecoverable');

    // Done is the only way out.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the scrim does not dismiss the dialog while the create is in flight', () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    createPending = true;
    renderPage();
    const dialog = openCreateDialog('');
    fireEvent.pointerDown(dialog);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows the in-flight submit label and disables both dialog buttons while creating', () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    createPending = true;
    renderPage();
    const dialog = openCreateDialog('');
    expect(within(dialog).getByRole('button', { name: 'Creating…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Create token' })).not.toBeInTheDocument();
  });

  it('focusing the revealed token field selects the whole value for copying', async () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    createSucceedsWith({ ...token(), token: 'tppm_select_me' });
    renderPage();
    const dialog = openCreateDialog('selectable');
    fireEvent.submit(dialog.querySelector('form')!);

    const field = await screen.findByLabelText<HTMLInputElement>('New personal access token');
    fireEvent.focus(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('tppm_select_me'.length);
  });

  it('falls back to the chosen scope when the create response omits scopes', async () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    // A not-yet-rebased API can answer without `scopes`; the reveal must still use
    // the MCP panel because the user asked for a read-only AI token.
    const created: CreatedMyApiToken = { ...token(), token: 'tppm_no_scopes_field' };
    delete (created as Partial<CreatedMyApiToken>).scopes;
    createSucceedsWith(created);
    renderPage();
    const dialog = openCreateDialog('Claude');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Read-only for AI assistants/i }));
    fireEvent.change(screen.getByLabelText(/Expiration/i), { target: { value: '2027-01-01' } });
    fireEvent.submit(dialog.querySelector('form')!);

    await waitFor(() =>
      expect(
        screen.getByRole('group', { name: /claude_desktop_config\.json snippet/i }),
      ).toBeInTheDocument(),
    );
  });

  it('shows the plain reveal when the create response omits scopes on a full-access token', async () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    const created: CreatedMyApiToken = { ...token(), token: 'tppm_plain_reveal' };
    delete (created as Partial<CreatedMyApiToken>).scopes;
    createSucceedsWith(created);
    renderPage();
    const dialog = openCreateDialog('script');
    fireEvent.submit(dialog.querySelector('form')!);

    await waitFor(() =>
      expect(screen.getByLabelText('New personal access token')).toHaveValue('tppm_plain_reveal'),
    );
    expect(
      screen.queryByRole('group', { name: /claude_desktop_config\.json snippet/i }),
    ).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Copy button
  // -------------------------------------------------------------------------

  it('reverts the copy confirmation to "Copy" after two seconds', async () => {
    const writeText = vi.fn<(v: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    createSucceedsWith({ ...token(), token: 'tppm_revert' });
    renderPage();
    const dialog = openCreateDialog('revert');
    fireEvent.submit(dialog.querySelector('form')!);
    const copyBtn = await screen.findByLabelText('Copy token');

    vi.useFakeTimers();
    fireEvent.click(copyBtn);
    await act(async () => {
      await Promise.resolve();
    });
    expect(copyBtn).toHaveTextContent('Copied');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(copyBtn).toHaveTextContent('Copy');
    expect(copyBtn).not.toHaveTextContent('Copied');
  });

  it('leaves the token readable when the clipboard write is refused', async () => {
    const writeText = vi
      .fn<(v: string) => Promise<void>>()
      .mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    createSucceedsWith({ ...token(), token: 'tppm_no_clipboard' });
    renderPage();
    const dialog = openCreateDialog('no-clipboard');
    fireEvent.submit(dialog.querySelector('form')!);
    const copyBtn = await screen.findByLabelText('Copy token');

    await act(async () => {
      fireEvent.click(copyBtn);
      await Promise.resolve();
    });
    // No "Copied" flip, no crash — the value stays selectable in its field.
    expect(copyBtn).toHaveTextContent('Copy');
    expect(copyBtn).not.toHaveTextContent('Copied');
    expect(screen.getByLabelText('New personal access token')).toHaveValue('tppm_no_clipboard');
  });

  // -------------------------------------------------------------------------
  // Revoke dialog
  // -------------------------------------------------------------------------

  it('closes the revoke dialog once the revoke mutation succeeds', () => {
    useMyApiTokens.mockReturnValue({
      data: [token()],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    revokeMutate.mockImplementation((_id: string, opts: { onSuccess: () => void }) => {
      opts.onSuccess();
    });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke token' }),
    );
    expect(revokeMutate).toHaveBeenCalledWith('t1', expect.any(Object));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows the in-flight revoke label and disables confirm while revoking', () => {
    useMyApiTokens.mockReturnValue({
      data: [token()],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    revokePending = true;
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Revoking…' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Revoke token' })).not.toBeInTheDocument();
  });

  it('clicking the revoke scrim cancels; clicking the panel keeps it open', () => {
    useMyApiTokens.mockReturnValue({
      data: [token()],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = screen.getByRole('alertdialog');

    fireEvent.pointerDown(dialog.firstElementChild!);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    fireEvent.pointerDown(dialog);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(revokeMutate).not.toHaveBeenCalled();
  });

  it('a non-Escape key leaves the revoke confirm dialog open', () => {
    useMyApiTokens.mockReturnValue({
      data: [token()],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.keyDown(document, { key: 'a' });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Error extraction + date fallbacks
  // -------------------------------------------------------------------------

  it('surfaces a scalar (non-array) server error message', async () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    createMutate.mockImplementation((_body: unknown, opts: { onError: (e: Error) => void }) => {
      const err = new Error('bad') as Error & { response?: { data?: unknown } };
      err.response = { data: { detail: 'Token cap reached.' } };
      opts.onError(err);
    });
    renderPage();
    const dialog = openCreateDialog('scalar');
    fireEvent.submit(dialog.querySelector('form')!);
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/Token cap reached\./),
    );
  });

  it('falls back to the generic message when the error body is an empty object', async () => {
    useMyApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    createMutate.mockImplementation((_body: unknown, opts: { onError: (e: Error) => void }) => {
      const err = new Error('bad') as Error & { response?: { data?: unknown } };
      err.response = { data: {} };
      opts.onError(err);
    });
    renderPage();
    const dialog = openCreateDialog('empty-body');
    fireEvent.submit(dialog.querySelector('form')!);
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/Something went wrong/i),
    );
  });

  it('renders the raw timestamp when locale date formatting is unavailable', () => {
    vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(() => {
      throw new Error('Intl unavailable');
    });
    useMyApiTokens.mockReturnValue({
      data: [token({ last_used_at: '2026-06-02T00:00:00Z' })],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText('Last used 2026-06-02T00:00:00Z')).toBeInTheDocument();
  });

  it('renders the raw expiry value when the expiry math throws', () => {
    vi.spyOn(Date.prototype, 'getTime').mockImplementation(() => {
      throw new Error('clock unavailable');
    });
    useMyApiTokens.mockReturnValue({
      data: [token({ expires_at: '2026-12-31T00:00:00Z' })],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText('2026-12-31T00:00:00Z')).toBeInTheDocument();
  });
});
