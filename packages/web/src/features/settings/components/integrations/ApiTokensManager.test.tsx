import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiTokensManager } from './ApiTokensManager';
import type { ApiToken, CreatedApiToken } from '@/hooks/useApiTokens';

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

  it('reveals the raw token exactly once on create', async () => {
    useApiTokens.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    // create.mutate(body, { onSuccess }) → fire onSuccess with a created token.
    createMutate.mockImplementation(
      (_body: unknown, opts: { onSuccess: (t: CreatedApiToken) => void }) => {
        opts.onSuccess({ ...TOKEN, id: 'tok-2', token: 'tppm_THE_RAW_SECRET' });
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
