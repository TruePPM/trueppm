import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExternalSourceConnectDialog } from './ExternalSourceConnectDialog';
import type { ExternalTaskSourceEntry } from '@/features/integrations/registry';

interface MutateOpts {
  onSuccess?: () => void;
  onError?: (err: unknown) => void;
}
const connectMutate = vi.fn<(input: unknown, opts?: MutateOpts) => void>();
const syncMutate = vi.fn();

// The wizard writes through the connect + sync mutations and formats errors with
// extractConnectionError. Mock the module so the dialog runs without apiClient;
// each test drives the connect mutation's onSuccess / onError callback.
vi.mock('@/hooks/useExternalConnection', () => ({
  useConnectExternalSource: () => ({ mutate: connectMutate, isPending: false }),
  useSyncExternalSource: () => ({ mutate: syncMutate, isPending: false }),
  extractConnectionError: (_err: unknown, fallback: string) => fallback,
}));

const JIRA: ExternalTaskSourceEntry = {
  provider: 'jira',
  name: 'Jira',
  description: 'Pull issues assigned to you into My Work.',
  status: 'available',
};

beforeEach(() => {
  connectMutate.mockReset();
  syncMutate.mockReset();
});

function fillCredentials() {
  fireEvent.change(screen.getByLabelText(/Site URL/i), {
    target: { value: 'https://acme.atlassian.net' },
  });
  fireEvent.change(screen.getByLabelText(/Account email/i), {
    target: { value: 'p.patel@acme.com' },
  });
  fireEvent.change(screen.getByLabelText(/API token/i), {
    target: { value: 'tok_secret_123' },
  });
}

describe('ExternalSourceConnectDialog', () => {
  it('gates Continue until all credentials are entered', () => {
    render(<ExternalSourceConnectDialog source={JIRA} onDismiss={vi.fn()} />);
    const cont = screen.getByRole('button', { name: /Continue/i });
    expect(cont).toBeDisabled();
    fillCredentials();
    expect(cont).toBeEnabled();
  });

  it('frames the connection as read-only, not an OAuth redirect', () => {
    render(<ExternalSourceConnectDialog source={JIRA} onDismiss={vi.fn()} />);
    expect(screen.getByText(/Read-only access/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot create or edit/i)).toBeInTheDocument();
    // A credential form, never a "Continue to Atlassian" OAuth button.
    expect(screen.queryByText(/Continue to Atlassian/i)).toBeNull();
  });

  it('submits a PUT with the assigned-to-me default (empty jql) and starts a sync', () => {
    connectMutate.mockImplementation((_input, opts) => opts?.onSuccess?.());
    const onDismiss = vi.fn();
    render(<ExternalSourceConnectDialog source={JIRA} onDismiss={onDismiss} />);
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    // Step 2 — "what to pull", assigned-to-me pre-selected.
    expect(screen.getByRole('button', { name: /Start importing/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Start importing/i }));
    expect(connectMutate).toHaveBeenCalledWith(
      {
        secret: 'tok_secret_123',
        base_url: 'https://acme.atlassian.net',
        account_email: 'p.patel@acme.com',
        jql: '',
        project_keys: [],
      },
      expect.any(Object),
    );
    // A first pull is kicked off, and the dialog closes on success.
    expect(syncMutate).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });

  it('sends a custom JQL and normalized project keys', () => {
    connectMutate.mockImplementation((_input, opts) => opts?.onSuccess?.());
    render(<ExternalSourceConnectDialog source={JIRA} onDismiss={vi.fn()} />);
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    fireEvent.click(screen.getByLabelText(/A specific JQL filter/i));
    fireEvent.change(screen.getByLabelText(/Projects/i), {
      target: { value: 'riv, BAY  riv' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Start importing/i }));
    expect(connectMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        jql: 'assignee = currentUser() AND statusCategory != Done',
        // upper-cased, whitespace/comma split, deduped
        project_keys: ['RIV', 'BAY'],
      }),
      expect.any(Object),
    );
  });

  it('surfaces a verification error and returns to the credential step', () => {
    connectMutate.mockImplementation((_input, opts) =>
      opts?.onError?.(new Error('rejected')),
    );
    render(<ExternalSourceConnectDialog source={JIRA} onDismiss={vi.fn()} />);
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /Start importing/i }));
    // Back on the credential step with the (mocked-through) error message.
    expect(screen.getByLabelText(/Site URL/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not connect to Jira/i);
  });
});
