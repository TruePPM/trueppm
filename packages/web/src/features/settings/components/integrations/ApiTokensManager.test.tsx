import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProvidersAndRouter } from '@/test/utils';
import { ApiTokensManager, buildClaudeDesktopConfig } from './ApiTokensManager';
import type { ApiToken, CreatedApiToken, ApiTokenCreateBody } from '@/hooks/useApiTokens';

const useApiTokens = vi.fn();
const createMutate = vi.fn();
const revokeMutate = vi.fn();
// Read lazily inside the mocked hooks so a test can flip the in-flight state
// before it renders (the create/revoke buttons and the dismiss guards branch
// on `isPending`).
let createPending = false;
let revokePending = false;

vi.mock('@/hooks/useApiTokens', () => ({
  useApiTokens: () => useApiTokens() as unknown,
  useCreateApiToken: () => ({ mutate: createMutate, isPending: createPending }),
  useRevokeApiToken: () => ({ mutate: revokeMutate, isPending: revokePending }),
}));

/** An Axios-shaped rejection carrying a DRF error body. */
function axiosErrorWith(data: unknown): Error {
  return Object.assign(new Error('Request failed with status code 400'), {
    isAxiosError: true,
    response: { status: 400, data },
  });
}

interface CreateHandlers {
  onSuccess: (token: CreatedApiToken) => void;
  onError: (error: Error) => void;
}

/** Open the create modal and return its dialog element. */
function openCreateModal(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
  return screen.getByRole('dialog', { name: /Create API token/i });
}

const SCOPE = { kind: 'program' as const, id: 'prog-1' };

const TOKEN: ApiToken = {
  id: 'tok-1',
  project: null,
  program: 'prog-1',
  name: 'CI Pipeline',
  token_prefix: 'tppm_a1b',
  status_map: {},
  scopes: ['legacy:full'],
  created_by: null,
  created_at: '2026-05-15T00:00:00Z',
  last_used_at: '2026-05-20T11:00:00Z',
  revoked_at: null,
  is_revoked: false,
};

const LOADED = (data: ApiToken[]) => ({
  data,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
});

beforeEach(() => {
  useApiTokens.mockReset();
  createMutate.mockReset();
  revokeMutate.mockReset();
  createPending = false;
  revokePending = false;
});

describe('ApiTokensManager', () => {
  it('shows the empty state with no tokens', () => {
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    expect(screen.getByText(/No tokens yet/i)).toBeInTheDocument();
  });

  it('renders a token row with name and prefix', () => {
    useApiTokens.mockReturnValue({ data: [TOKEN], isLoading: false, isError: false, refetch: vi.fn() });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    expect(screen.getByText('CI Pipeline')).toBeInTheDocument();
    expect(screen.getByText(/tppm_a1b/)).toBeInTheDocument();
  });

  it('shows each token’s scope in its row', () => {
    const mcpToken: ApiToken = {
      ...TOKEN,
      id: 'tok-mcp',
      name: 'Claude on my laptop',
      scopes: ['mcp:read'],
    };
    useApiTokens.mockReturnValue({
      data: [TOKEN, mcpToken],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    expect(screen.getByText('Full')).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });

  it('renders no scope badge when a token has no scopes (backend without scopes yet)', () => {
    const legacyRow: ApiToken = { ...TOKEN, scopes: undefined };
    useApiTokens.mockReturnValue({
      data: [legacyRow],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    expect(screen.queryByText('Full')).not.toBeInTheDocument();
    expect(screen.queryByText('Read-only')).not.toBeInTheDocument();
  });

  it('does not offer the mcp:read scope here, and says where to get one (#2890)', () => {
    // A token minted at project/program scope has a null owner, and the MCP read
    // surface admits owner-scoped (personal) tokens only (#1712) — so the option
    // that used to sit here produced a config that 401'd the MCP server at boot.
    // The pointer is load-bearing: this page is where a user looks for it.
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create API token/i });
    expect(
      within(dialog).queryByRole('radio', { name: /Read-only for AI assistants/i }),
    ).not.toBeInTheDocument();
    const link = within(dialog).getByRole('link', { name: /Personal Settings/i });
    expect(link).toHaveAttribute('href', '/me/settings/api-tokens');
  });

  it('submits the full-access scope in the create body', () => {
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create API token/i });
    fireEvent.change(within(dialog).getByPlaceholderText(/Jira Production/i), {
      target: { value: 'CI Pipeline' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));
    const body = createMutate.mock.calls[0][0] as ApiTokenCreateBody;
    expect(body).toEqual({ name: 'CI Pipeline', scopes: ['legacy:full'] });
  });

  it('reveals the raw token exactly once on create (full scope)', async () => {
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    createMutate.mockImplementation(
      (_body: unknown, opts: { onSuccess: (t: CreatedApiToken) => void }) => {
        opts.onSuccess({ ...TOKEN, id: 'tok-2', scopes: ['legacy:full'], token: 'tppm_THE_RAW_SECRET' });
      },
    );
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create API token/i });
    fireEvent.change(within(dialog).getByPlaceholderText(/Jira Production/i), {
      target: { value: 'My token' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));
    await waitFor(() => {
      expect(screen.getByText(/only time you.ll see this token/i)).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('tppm_THE_RAW_SECRET')).toBeInTheDocument();
  });

  it('never renders the MCP connect snippet on this surface (#2890)', async () => {
    // Belt and braces on the scope removal: even if the API echoed an mcp:read
    // token back, this page must not hand out a config that cannot connect. The
    // snippet's own coverage lives with the surface that mints the credential the
    // MCP server accepts — PersonalAccessTokensPage.test.tsx.
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    createMutate.mockImplementation(
      (_body: unknown, opts: { onSuccess: (t: CreatedApiToken) => void }) => {
        opts.onSuccess({ ...TOKEN, id: 'tok-3', scopes: ['mcp:read'], token: 'tppm_MCP_SECRET' });
      },
    );
    const { unmount } = renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create API token/i });
    fireEvent.change(within(dialog).getByPlaceholderText(/Jira Production/i), {
      target: { value: 'CI Pipeline' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));

    // The plain one-time reveal, not the connect panel.
    await waitFor(() => {
      expect(screen.getByDisplayValue('tppm_MCP_SECRET')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('claude_desktop_config.json snippet')).not.toBeInTheDocument();
    expect(screen.queryByText('Try asking')).not.toBeInTheDocument();

    // One-time secret: after Done the modal closes and the token is not re-shown.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByDisplayValue('tppm_MCP_SECRET')).not.toBeInTheDocument();
    unmount();
  });

  it('confirms before revoking', () => {
    useApiTokens.mockReturnValue({ data: [TOKEN], isLoading: false, isError: false, refetch: vi.fn() });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByRole('alertdialog', { name: /Revoke token/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
    expect(revokeMutate).toHaveBeenCalledWith('tok-1', expect.anything());
  });

  it('renders program-scoped explanatory copy at program scope (#597)', () => {
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    expect(
      screen.getByText(/Program API tokens authenticate scripts and integrations/i),
    ).toBeInTheDocument();
  });

  it('renders project-scoped explanatory copy at project scope (#597)', () => {
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    renderWithProvidersAndRouter(<ApiTokensManager scope={{ kind: 'project', id: 'p-1' }} />);
    expect(
      screen.getByText(/API tokens authenticate scripts and integrations that read or modify/i),
    ).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // List states: loading / error / no data
  // -------------------------------------------------------------------------

  it('shows a busy placeholder while the list is loading, not the empty state', () => {
    useApiTokens.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    expect(screen.getByLabelText('Loading tokens')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/No tokens yet/i)).not.toBeInTheDocument();
  });

  it('offers a retry that refetches when the list fails to load', () => {
    const refetch = vi.fn();
    useApiTokens.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    expect(screen.getByText(/Couldn.t load tokens/i)).toBeInTheDocument();
    expect(screen.queryByText(/No tokens yet/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state and no count badge when the list resolved to nothing', () => {
    useApiTokens.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    expect(screen.getByText(/No tokens yet/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/active tokens/i)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Row states
  // -------------------------------------------------------------------------

  it('counts only live tokens and drops the revoke control on a revoked row', () => {
    const revoked: ApiToken = {
      ...TOKEN,
      id: 'tok-old',
      name: 'Retired CI',
      is_revoked: true,
      revoked_at: '2026-05-21T00:00:00Z',
    };
    useApiTokens.mockReturnValue(LOADED([TOKEN, revoked]));
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);

    // Two rows, but the badge counts the one that still works.
    expect(screen.getByLabelText('1 active tokens')).toHaveTextContent('1');
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    // Only the live token can be revoked.
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
  });

  it('marks a token that has never been used', () => {
    useApiTokens.mockReturnValue(LOADED([{ ...TOKEN, last_used_at: null }]));
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    expect(screen.getByText('never used')).toBeInTheDocument();
    expect(screen.queryByText('in use')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Create modal: validation, errors, in-flight, dismissal
  // -------------------------------------------------------------------------

  it('refuses to create a token with a blank name', () => {
    useApiTokens.mockReturnValue(LOADED([]));
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    const dialog = openCreateModal();
    fireEvent.change(within(dialog).getByPlaceholderText(/Jira Production/i), {
      target: { value: '   ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('Give the token a name.');
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('clears the validation error once a valid name is submitted', () => {
    useApiTokens.mockReturnValue(LOADED([]));
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    const dialog = openCreateModal();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();

    fireEvent.change(within(dialog).getByPlaceholderText(/Jira Production/i), {
      target: { value: '  Jira  ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));

    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    const body = createMutate.mock.calls[0][0] as ApiTokenCreateBody;
    expect(body.name).toBe('Jira');
  });

  it('surfaces a DRF field error from a failed create', () => {
    useApiTokens.mockReturnValue(LOADED([]));
    createMutate.mockImplementation((_body: unknown, opts: CreateHandlers) => {
      opts.onError(axiosErrorWith({ name: ['A token with that name already exists.'] }));
    });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    const dialog = openCreateModal();
    fireEvent.change(within(dialog).getByPlaceholderText(/Jira Production/i), {
      target: { value: 'CI Pipeline' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'name: A token with that name already exists.',
    );
  });

  it('surfaces a scalar (non-list) error field from a failed create', () => {
    useApiTokens.mockReturnValue(LOADED([]));
    createMutate.mockImplementation((_body: unknown, opts: CreateHandlers) => {
      opts.onError(axiosErrorWith({ detail: 'You do not have permission.' }));
    });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    const dialog = openCreateModal();
    fireEvent.change(within(dialog).getByPlaceholderText(/Jira Production/i), {
      target: { value: 'CI Pipeline' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'detail: You do not have permission.',
    );
  });

  it('falls back to a generic message when the error body carries no fields', () => {
    useApiTokens.mockReturnValue(LOADED([]));
    createMutate.mockImplementation((_body: unknown, opts: CreateHandlers) => {
      opts.onError(axiosErrorWith({}));
    });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    const dialog = openCreateModal();
    fireEvent.change(within(dialog).getByPlaceholderText(/Jira Production/i), {
      target: { value: 'CI Pipeline' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    );
  });

  it('falls back to a generic message when the failure is not an Axios error', () => {
    useApiTokens.mockReturnValue(LOADED([]));
    createMutate.mockImplementation((_body: unknown, opts: CreateHandlers) => {
      opts.onError(new Error('Network Error'));
    });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    const dialog = openCreateModal();
    fireEvent.change(within(dialog).getByPlaceholderText(/Jira Production/i), {
      target: { value: 'CI Pipeline' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    );
  });

  it('shows a pending label and locks both actions while the create is in flight', () => {
    createPending = true;
    useApiTokens.mockReturnValue(LOADED([]));
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create API token/i });

    expect(within(dialog).getByRole('button', { name: 'Creating…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('closes the create form on Escape', () => {
    useApiTokens.mockReturnValue(LOADED([]));
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    openCreateModal();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores Escape while the create is in flight', () => {
    createPending = true;
    useApiTokens.mockReturnValue(LOADED([]));
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: /Create API token/i })).toBeInTheDocument();
  });

  it('dismisses the create form on a backdrop press but not on a press inside it', () => {
    useApiTokens.mockReturnValue(LOADED([]));
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    const dialog = openCreateModal();

    // A press that originates on a control inside the panel must not dismiss.
    fireEvent.pointerDown(within(dialog).getByPlaceholderText(/Jira Production/i));
    expect(screen.getByRole('dialog', { name: /Create API token/i })).toBeInTheDocument();

    fireEvent.pointerDown(dialog);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never lets a backdrop press dismiss the one-time reveal (#2205)', () => {
    useApiTokens.mockReturnValue(LOADED([]));
    createMutate.mockImplementation((_body: unknown, opts: CreateHandlers) => {
      opts.onSuccess({ ...TOKEN, id: 'tok-9', scopes: ['legacy:full'], token: 'tppm_ONE_SHOT' });
    });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    const dialog = openCreateModal();
    fireEvent.change(within(dialog).getByPlaceholderText(/Jira Production/i), {
      target: { value: 'CI' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));

    const reveal = screen.getByRole('dialog', { name: 'Token created' });
    fireEvent.pointerDown(reveal);

    expect(screen.getByDisplayValue('tppm_ONE_SHOT')).toBeInTheDocument();
  });

  it('selects the token field on focus so the secret can be copied by keyboard', () => {
    useApiTokens.mockReturnValue(LOADED([]));
    createMutate.mockImplementation((_body: unknown, opts: CreateHandlers) => {
      opts.onSuccess({ ...TOKEN, id: 'tok-10', scopes: ['legacy:full'], token: 'tppm_SELECT_ME' });
    });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    const dialog = openCreateModal();
    fireEvent.change(within(dialog).getByPlaceholderText(/Jira Production/i), {
      target: { value: 'CI' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));

    const field = screen.getByLabelText<HTMLInputElement>('New API token');
    expect(field.readOnly).toBe(true);
    fireEvent.focus(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('tppm_SELECT_ME'.length);
  });

  it('still reveals the token when the create response omits scopes', async () => {
    // A backend rolled out ahead of / behind the scopes field omits the key
    // entirely. The reveal must not depend on reading it back — losing a
    // one-time secret to a missing optional field is unrecoverable.
    useApiTokens.mockReturnValue(LOADED([]));
    createMutate.mockImplementation((_body: unknown, opts: CreateHandlers) => {
      opts.onSuccess({ ...TOKEN, id: 'tok-11', scopes: undefined, token: 'tppm_NO_SCOPES' });
    });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    const dialog = openCreateModal();
    fireEvent.change(within(dialog).getByPlaceholderText(/Jira Production/i), {
      target: { value: 'CI Pipeline' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));

    await waitFor(() => {
      expect(screen.getByDisplayValue('tppm_NO_SCOPES')).toBeInTheDocument();
    });
  });

  it('closes the create form when Cancel is pressed', () => {
    useApiTokens.mockReturnValue(LOADED([]));
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    const dialog = openCreateModal();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(createMutate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Revoke confirmation
  // -------------------------------------------------------------------------

  it('leaves the token alone when the revoke confirmation is canceled', () => {
    useApiTokens.mockReturnValue(LOADED([TOKEN]));
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const confirm = screen.getByRole('alertdialog', { name: /Revoke token/i });

    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(revokeMutate).not.toHaveBeenCalled();
  });

  it('dismisses the confirmation once the revoke succeeds', async () => {
    useApiTokens.mockReturnValue(LOADED([TOKEN]));
    revokeMutate.mockImplementation((_id: string, opts: { onSuccess: () => void }) => {
      opts.onSuccess();
    });
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(revokeMutate).toHaveBeenCalledWith('tok-1', expect.anything());
  });

  it('keeps the confirmation open and its buttons locked while the revoke is in flight', () => {
    revokePending = true;
    useApiTokens.mockReturnValue(LOADED([TOKEN]));
    renderWithProvidersAndRouter(<ApiTokensManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const confirm = screen.getByRole('alertdialog', { name: /Revoke token/i });

    expect(within(confirm).getByRole('button', { name: 'Working…' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('alertdialog', { name: /Revoke token/i })).toBeInTheDocument();
  });
});

describe('buildClaudeDesktopConfig', () => {
  it('produces the trueppm-mcp config shape matching the package + admin doc', () => {
    const json = buildClaudeDesktopConfig('https://ppm.example.com', 'tppm_abc');
    const parsed = JSON.parse(json) as {
      mcpServers: { trueppm: { command: string; env: Record<string, string> } };
    };
    expect(parsed.mcpServers.trueppm.command).toBe('trueppm-mcp');
    expect(parsed.mcpServers.trueppm.env).toEqual({
      TRUEPPM_API_URL: 'https://ppm.example.com',
      TRUEPPM_API_TOKEN: 'tppm_abc',
    });
    // No /api/v1 suffix — the server appends it (config._compose_base_url).
    expect(parsed.mcpServers.trueppm.env.TRUEPPM_API_URL).not.toContain('/api/v1');
  });
});
