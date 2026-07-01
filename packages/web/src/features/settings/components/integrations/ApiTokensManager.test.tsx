import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiTokensManager, buildClaudeDesktopConfig } from './ApiTokensManager';
import type { ApiToken, CreatedApiToken, ApiTokenCreateBody } from '@/hooks/useApiTokens';

const useApiTokens = vi.fn();
const createMutate = vi.fn();
const revokeMutate = vi.fn();

vi.mock('@/hooks/useApiTokens', () => ({
  useApiTokens: () => useApiTokens() as unknown,
  useCreateApiToken: () => ({ mutate: createMutate, isPending: false }),
  useRevokeApiToken: () => ({ mutate: revokeMutate, isPending: false }),
}));

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

beforeEach(() => {
  useApiTokens.mockReset();
  createMutate.mockReset();
  revokeMutate.mockReset();
});

describe('ApiTokensManager', () => {
  it('shows the empty state with no tokens', () => {
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(<ApiTokensManager scope={SCOPE} />);
    expect(screen.getByText(/No tokens yet/i)).toBeInTheDocument();
  });

  it('renders a token row with name and prefix', () => {
    useApiTokens.mockReturnValue({ data: [TOKEN], isLoading: false, isError: false, refetch: vi.fn() });
    render(<ApiTokensManager scope={SCOPE} />);
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
    render(<ApiTokensManager scope={SCOPE} />);
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
    render(<ApiTokensManager scope={SCOPE} />);
    expect(screen.queryByText('Full')).not.toBeInTheDocument();
    expect(screen.queryByText('Read-only')).not.toBeInTheDocument();
  });

  it('offers both capability scopes in the create form', () => {
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(<ApiTokensManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create API token/i });
    expect(within(dialog).getByRole('radio', { name: /Full access/i })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: /Read-only for AI assistants/i })).toBeInTheDocument();
  });

  it('submits the selected scope in the create body', () => {
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(<ApiTokensManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create API token/i });
    fireEvent.change(within(dialog).getByPlaceholderText(/Jira Production/i), {
      target: { value: 'Claude' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Read-only for AI assistants/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));
    const body = createMutate.mock.calls[0][0] as ApiTokenCreateBody;
    expect(body).toEqual({ name: 'Claude', scopes: ['mcp:read'] });
  });

  it('reveals the raw token exactly once on create (full scope)', async () => {
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    createMutate.mockImplementation(
      (_body: unknown, opts: { onSuccess: (t: CreatedApiToken) => void }) => {
        opts.onSuccess({ ...TOKEN, id: 'tok-2', scopes: ['legacy:full'], token: 'tppm_THE_RAW_SECRET' });
      },
    );
    render(<ApiTokensManager scope={SCOPE} />);
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

  it('reveals the connect snippet for an mcp:read token, once', async () => {
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    createMutate.mockImplementation(
      (_body: unknown, opts: { onSuccess: (t: CreatedApiToken) => void }) => {
        opts.onSuccess({ ...TOKEN, id: 'tok-3', scopes: ['mcp:read'], token: 'tppm_MCP_SECRET' });
      },
    );
    const { unmount } = render(<ApiTokensManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = screen.getByRole('dialog', { name: /Create API token/i });
    fireEvent.change(within(dialog).getByPlaceholderText(/Jira Production/i), {
      target: { value: 'Claude Desktop' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Read-only for AI assistants/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create token' }));

    // The connect snippet renders with the command, env vars, instance URL, and token.
    const snippet = await screen.findByLabelText('claude_desktop_config.json snippet');
    expect(snippet.textContent).toContain('"command": "trueppm-mcp"');
    expect(snippet.textContent).toContain('"TRUEPPM_API_URL"');
    expect(snippet.textContent).toContain('"TRUEPPM_API_TOKEN": "tppm_MCP_SECRET"');
    expect(snippet.textContent).toContain(window.location.origin);
    // The raw token is also shown in its own field, exactly once.
    expect(screen.getByDisplayValue('tppm_MCP_SECRET')).toBeInTheDocument();

    // One-time secret: after Done the modal closes and the token is not re-shown.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByDisplayValue('tppm_MCP_SECRET')).not.toBeInTheDocument();
    unmount();
  });

  it('confirms before revoking', () => {
    useApiTokens.mockReturnValue({ data: [TOKEN], isLoading: false, isError: false, refetch: vi.fn() });
    render(<ApiTokensManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByRole('alertdialog', { name: /Revoke token/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
    expect(revokeMutate).toHaveBeenCalledWith('tok-1', expect.anything());
  });

  it('renders program-scoped explanatory copy at program scope (#597)', () => {
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(<ApiTokensManager scope={SCOPE} />);
    expect(
      screen.getByText(/Program API tokens authenticate scripts and integrations/i),
    ).toBeInTheDocument();
  });

  it('renders project-scoped explanatory copy at project scope (#597)', () => {
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(<ApiTokensManager scope={{ kind: 'project', id: 'p-1' }} />);
    expect(
      screen.getByText(/API tokens authenticate scripts and integrations that read or modify/i),
    ).toBeInTheDocument();
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
