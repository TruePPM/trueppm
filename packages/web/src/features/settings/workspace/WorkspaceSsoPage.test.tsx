import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceSsoPage } from './WorkspaceSsoPage';
import type { OidcProviderConfig } from '@/hooks/useSso';
import { ROLE_MEMBER } from '@/lib/roles';

// The page is fully hook-backed; mock the data/mutation/dirty-form hooks so it
// renders without a QueryClientProvider.
const BLANK: OidcProviderConfig = {
  enabled: false,
  display_name: '',
  issuer_url: '',
  client_id: '',
  scopes: ['openid', 'email', 'profile'],
  allowed_email_domains: [],
  auto_create_members: false,
  default_role: ROLE_MEMBER,
  allow_password_signin: true,
  allow_password_signin_enforced: false,
  secret_set: false,
  redirect_uri: 'https://app.example.com/api/v1/auth/oidc/callback/',
  created_at: '2026-07-11T00:00:00Z',
  updated_at: '2026-07-11T00:00:00Z',
};

const CONFIGURED: OidcProviderConfig = {
  ...BLANK,
  enabled: true,
  display_name: 'Acme SSO',
  issuer_url: 'https://id.acme.io',
  client_id: 'trueppm-web',
  allowed_email_domains: ['acme.io'],
  auto_create_members: true,
  secret_set: true,
};

let providerData: OidcProviderConfig = BLANK;

vi.mock('@/hooks/useSso', () => ({
  useOidcProvider: () => ({ data: providerData, isLoading: false, isError: false }),
  useUpdateOidcProvider: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteOidcProvider: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTestOidcConnection: () => ({ mutate: vi.fn(), isPending: false, data: undefined }),
}));
vi.mock('../hooks/useDirtyForm', () => ({ useDirtyForm: () => undefined }));
// EnterpriseBadge reads the edition — community so the enforced-SSO upsell renders.
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: 'community', isLoading: false }),
}));

describe('WorkspaceSsoPage', () => {
  beforeEach(() => {
    providerData = BLANK;
  });

  it('shows the empty state with a connect CTA when nothing is configured', () => {
    render(<WorkspaceSsoPage />);
    expect(screen.getByText('No identity provider connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect OIDC provider' })).toBeInTheDocument();
  });

  it('reveals the config form when Connect is clicked from the empty state', async () => {
    render(<WorkspaceSsoPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Connect OIDC provider' }));
    expect(screen.getByLabelText('Issuer URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Client ID')).toBeInTheDocument();
  });

  it('renders the live status, redirect URI, and fixed scopes when configured', () => {
    providerData = CONFIGURED;
    render(<WorkspaceSsoPage />);
    expect(screen.getByText('OIDC sign-in is live')).toBeInTheDocument();
    expect(screen.getByDisplayValue(CONFIGURED.redirect_uri)).toBeInTheDocument();
    expect(screen.getByText('openid email profile')).toBeInTheDocument();
  });

  it('keeps enforced-SSO (disable local accounts) as an Enterprise upsell, not a switch', () => {
    providerData = CONFIGURED;
    render(<WorkspaceSsoPage />);
    // Password sign-in is stated as allowed; the EE badge marks enforcement as Enterprise.
    expect(screen.getByText(/Password and SSO sign-in are both allowed/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Available in TruePPM Enterprise/i })).toBeInTheDocument();
    // There is no functional "disable password sign-in" switch in OSS.
    expect(
      screen.queryByRole('switch', { name: /disable password/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the default-role picker only when auto-create is on', () => {
    providerData = { ...CONFIGURED, auto_create_members: false };
    const { rerender } = render(<WorkspaceSsoPage />);
    expect(
      screen.queryByLabelText('Default role for auto-created members'),
    ).not.toBeInTheDocument();

    providerData = { ...CONFIGURED, auto_create_members: true };
    rerender(<WorkspaceSsoPage />);
    expect(screen.getByLabelText('Default role for auto-created members')).toBeInTheDocument();
  });
});
