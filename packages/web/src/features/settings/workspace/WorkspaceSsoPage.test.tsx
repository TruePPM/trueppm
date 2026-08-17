import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceSsoPage } from './WorkspaceSsoPage';
import type { SsoProvider } from '@/hooks/useSso';

const KEYCLOAK: SsoProvider = {
  slug: 'keycloak',
  provider: 'openid_connect',
  kind: 'derived',
  display_name: 'Acme SSO',
  enabled: true,
  client_id: 'trueppm-web',
  server_url: 'https://id.acme.io/realms/main',
  github_org: '',
  scopes: ['openid', 'email', 'profile'],
  allowed_email_domains: ['acme.io'],
  auto_create_members: true,
  default_role: 100,
  allow_password_signin: true,
  allow_password_signin_enforced: false,
  secret_set: true,
  redirect_uri: 'https://app.acme.io/api/v1/auth/oidc/callback/',
  linked_account_count: 0,
  locked_out_account_count: 0,
  created_at: '2026-07-11T00:00:00Z',
  updated_at: '2026-07-11T00:00:00Z',
};

let providersData: SsoProvider[] = [];
const deleteMutate = vi.fn(() => Promise.resolve());

vi.mock('@/hooks/useSso', () => ({
  useSsoProviders: () => ({ data: providersData, isLoading: false, isError: false }),
  useDeleteSsoProvider: () => ({ mutateAsync: deleteMutate, isPending: false }),
  useCreateSsoProvider: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateSsoProvider: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTestSsoConnection: () => ({ mutate: vi.fn(), isPending: false, data: undefined }),
}));
// EnterpriseBadge (rendered inside the panel) reads the edition.
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: 'community', isLoading: false }),
}));

describe('WorkspaceSsoPage', () => {
  beforeEach(() => {
    providersData = [];
    deleteMutate.mockClear();
  });

  it('shows the empty state with an Add CTA when nothing is configured', () => {
    render(<WorkspaceSsoPage />);
    expect(screen.getByText('No identity provider connected')).toBeInTheDocument();
    expect(screen.getByText('SSO sign-in is not enabled yet')).toBeInTheDocument();
  });

  it('opens the Add panel with the provider-type picker and Keycloak fields', async () => {
    render(<WorkspaceSsoPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add provider' }));

    // The type picker defaults to Keycloak — a derived, two-field provider.
    expect(screen.getByLabelText('Provider type')).toBeInTheDocument();
    expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Realm')).toBeInTheDocument();
    expect(screen.getByLabelText('Client ID')).toBeInTheDocument();
  });

  it('composes the resolved issuer live as derived fields are filled', async () => {
    render(<WorkspaceSsoPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add provider' }));

    await user.type(screen.getByLabelText('Base URL'), 'https://id.example.com');
    await user.type(screen.getByLabelText('Realm'), 'main');
    expect(screen.getByTestId('resolved-issuer')).toHaveTextContent(
      'https://id.example.com/realms/main',
    );
  });

  it('renders a live status and a provider row when configured', () => {
    providersData = [KEYCLOAK];
    render(<WorkspaceSsoPage />);
    expect(screen.getByText('SSO sign-in is live')).toBeInTheDocument();
    expect(screen.getByText('Acme SSO')).toBeInTheDocument();
    expect(screen.getByText('Keycloak · OIDC')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('pre-fills the Edit panel from the stored provider', async () => {
    providersData = [KEYCLOAK];
    render(<WorkspaceSsoPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    // The Keycloak issuer decomposes back into Base URL + Realm.
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://id.acme.io');
    expect(screen.getByLabelText('Realm')).toHaveValue('main');
    expect(screen.getByLabelText('Client ID')).toHaveValue('trueppm-web');
  });

  it('confirms via a styled dialog before removing a provider', async () => {
    providersData = [KEYCLOAK];
    render(<WorkspaceSsoPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('alertdialog', { name: /Remove Acme SSO\?/i });
    expect(deleteMutate).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Remove provider' }));
    expect(deleteMutate).toHaveBeenCalledWith({ slug: 'keycloak', confirmLockout: false });
  });

  it('names how many members lose their only sign-in method before removing (#2874)', async () => {
    // The old copy promised these users "fall back to password sign-in", which they
    // cannot: an SSO-created account has an unusable password and the reset email
    // never arrives. The count is what makes the confirmation informed.
    providersData = [{ ...KEYCLOAK, linked_account_count: 4, locked_out_account_count: 3 }];
    render(<WorkspaceSsoPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('alertdialog', { name: /Remove Acme SSO\?/i });
    expect(dialog).toHaveTextContent(/3 members sign in only through this provider/i);
    expect(dialog).toHaveTextContent(/not be able to sign in at all/i);
    expect(dialog).not.toHaveTextContent(/fall back to password sign-in/i);

    await user.click(within(dialog).getByRole('button', { name: 'Remove provider' }));
    expect(deleteMutate).toHaveBeenCalledWith({ slug: 'keycloak', confirmLockout: true });
  });

  it('uses the singular form for a single stranded member', async () => {
    providersData = [{ ...KEYCLOAK, linked_account_count: 1, locked_out_account_count: 1 }];
    render(<WorkspaceSsoPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('alertdialog', { name: /Remove Acme SSO\?/i })).toHaveTextContent(
      /1 member signs in only through this provider/i,
    );
  });

  it('keeps enforced-SSO as an Enterprise upsell, not a switch, inside the panel', async () => {
    providersData = [KEYCLOAK];
    render(<WorkspaceSsoPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByText(/Password and SSO sign-in are both allowed/i)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Available in TruePPM Enterprise/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /disable password/i })).not.toBeInTheDocument();
  });
});
