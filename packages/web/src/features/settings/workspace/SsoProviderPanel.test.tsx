import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SsoProviderPanel } from './SsoProviderPanel';
import type { SsoProvider } from '@/hooks/useSso';

// Controllable mutation handles shared across the mocked useSso hooks.
const h = vi.hoisted(() => ({
  createMutateAsync: vi.fn<(body: unknown) => Promise<unknown>>(),
  updateMutateAsync: vi.fn<(arg: unknown) => Promise<unknown>>(),
  testMutate: vi.fn<(slug: string) => void>(),
  createPending: false,
  updatePending: false,
  testPending: false,
  testData: undefined as { ok: boolean; detail?: string; error?: string } | undefined,
}));

vi.mock('@/hooks/useSso', () => ({
  useCreateSsoProvider: () => ({ mutateAsync: h.createMutateAsync, isPending: h.createPending }),
  useUpdateSsoProvider: () => ({ mutateAsync: h.updateMutateAsync, isPending: h.updatePending }),
  useTestSsoConnection: () => ({ mutate: h.testMutate, isPending: h.testPending, data: h.testData }),
}));

// EnterpriseBadge (rendered in the panel's Password-sign-in row) reads the edition.
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: 'community', isLoading: false }),
}));

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
  created_at: '2026-07-11T00:00:00Z',
  updated_at: '2026-07-11T00:00:00Z',
};

function renderPanel(props: Partial<ComponentProps<typeof SsoProviderPanel>> = {}) {
  const onClose = props.onClose ?? vi.fn();
  render(
    <SsoProviderPanel
      mode="add"
      sharedRedirectUri="https://app.example.com/api/v1/auth/oidc/callback/"
      onClose={onClose}
      {...props}
    />,
  );
  return { onClose };
}

beforeEach(() => {
  h.createMutateAsync.mockReset().mockResolvedValue({});
  h.updateMutateAsync.mockReset().mockResolvedValue({});
  h.testMutate.mockReset();
  h.createPending = false;
  h.updatePending = false;
  h.testPending = false;
  h.testData = undefined;
  // jsdom lacks a clipboard by default; the CopyButton writes to it.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe('SsoProviderPanel — Add mode, provider-type switching', () => {
  it('defaults to Keycloak (derived, two fields) and composes the resolved issuer live', async () => {
    const user = userEvent.setup();
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Add provider' })).toBeInTheDocument();
    // Keycloak is derived → Base URL + Realm inputs and a live resolved-issuer strip.
    await user.type(screen.getByLabelText('Base URL'), 'https://id.example.com');
    await user.type(screen.getByLabelText('Realm'), 'main');
    expect(screen.getByTestId('resolved-issuer')).toHaveTextContent(
      'https://id.example.com/realms/main',
    );
  });

  it('shows the placeholder strip before a derived issuer can be composed', () => {
    renderPanel();
    expect(screen.getByTestId('resolved-issuer')).toHaveTextContent(
      'Fill the fields above to compose the issuer…',
    );
  });

  it('switches to Generic OIDC (free) — a single Issuer URL field, no resolved strip', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.selectOptions(screen.getByLabelText('Provider type'), 'generic');

    expect(screen.getByLabelText('Issuer URL')).toBeInTheDocument();
    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument();
    // free kind has no "Resolved issuer" strip (that is derived-only).
    expect(screen.queryByTestId('resolved-issuer')).not.toBeInTheDocument();
  });

  it('switches to Google (fixed) — a read-only auto-configured issuer, no inputs', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.selectOptions(screen.getByLabelText('Provider type'), 'google');

    expect(screen.getByText('https://accounts.google.com')).toBeInTheDocument();
    expect(screen.getByText('auto')).toBeInTheDocument();
    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Issuer URL')).not.toBeInTheDocument();
  });

  it('switches to GitHub (oauth) — OAuth callout, org field, and OAuth scopes', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.selectOptions(screen.getByLabelText('Provider type'), 'github');

    expect(screen.getByText(/GitHub uses OAuth/)).toBeInTheDocument();
    expect(screen.getByLabelText('Organization')).toBeInTheDocument();
    // OAuth providers advertise the GitHub scopes, not the OIDC set.
    expect(screen.getByText('read:user')).toBeInTheDocument();
    expect(screen.getByText('user:email')).toBeInTheDocument();
    expect(screen.queryByText('openid')).not.toBeInTheDocument();
  });

  it('clears type-specific inputs when the provider type changes', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByLabelText('Base URL'), 'https://id.example.com');
    await user.selectOptions(screen.getByLabelText('Provider type'), 'entra');
    // Entra is derived on a single Tenant ID field; the old Base URL value is gone.
    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Tenant ID')).toHaveValue('');
  });
});

describe('SsoProviderPanel — save (create)', () => {
  it('creates an OIDC provider with the composed issuer and parsed domains, then closes', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel();

    await user.type(screen.getByLabelText('Base URL'), 'https://id.example.com');
    await user.type(screen.getByLabelText('Realm'), 'main');
    await user.type(screen.getByLabelText('Display name'), 'Example SSO');
    await user.type(screen.getByLabelText('Client ID'), 'client-xyz');
    await user.type(screen.getByLabelText('Client secret'), 'sekret');
    await user.type(
      screen.getByLabelText('Allowed email domains'),
      '@Example.com, example.io  example.com',
    );

    await user.click(screen.getByRole('button', { name: 'Add provider' }));

    expect(h.createMutateAsync).toHaveBeenCalledTimes(1);
    const body = h.createMutateAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      slug: 'keycloak',
      display_name: 'Example SSO',
      client_id: 'client-xyz',
      client_secret: 'sekret',
      server_url: 'https://id.example.com/realms/main',
      // deduped, lowercased, @-stripped.
      allowed_email_domains: ['example.com', 'example.io'],
    });
    expect(body).not.toHaveProperty('github_org');
    expect(onClose).toHaveBeenCalled();
  });

  it('omits client_secret from the body when left blank (keep the stored secret)', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByLabelText('Base URL'), 'https://id.example.com');
    await user.type(screen.getByLabelText('Realm'), 'main');
    await user.click(screen.getByRole('button', { name: 'Add provider' }));

    const body = h.createMutateAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('client_secret');
  });

  it('creates a GitHub OAuth provider with github_org and no server_url', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.selectOptions(screen.getByLabelText('Provider type'), 'github');
    await user.type(screen.getByLabelText('Organization'), '  acme-inc  ');
    await user.click(screen.getByRole('button', { name: 'Add provider' }));

    const body = h.createMutateAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(body.github_org).toBe('acme-inc');
    expect(body).not.toHaveProperty('server_url');
  });

  it('surfaces a DRF field error and keeps the panel open on save failure', async () => {
    h.createMutateAsync.mockRejectedValue({
      response: { data: { server_url: ['Enter a valid URL.'] } },
    });
    const user = userEvent.setup();
    const { onClose } = renderPanel();
    await user.type(screen.getByLabelText('Base URL'), 'https://id.example.com');
    await user.type(screen.getByLabelText('Realm'), 'main');
    await user.click(screen.getByRole('button', { name: 'Add provider' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid URL.');
    expect(screen.getByText(/Your entries are kept/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('falls back to a generic message for an unrecognized error shape', async () => {
    h.createMutateAsync.mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByLabelText('Base URL'), 'https://id.example.com');
    await user.type(screen.getByLabelText('Realm'), 'main');
    await user.click(screen.getByRole('button', { name: 'Add provider' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not save the provider. Check the highlighted fields.',
    );
  });

  it('clears a previous save error as soon as a field is edited', async () => {
    h.createMutateAsync.mockRejectedValue({ response: { data: { slug: 'taken' } } });
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByLabelText('Base URL'), 'https://id.example.com');
    await user.type(screen.getByLabelText('Realm'), 'main');
    await user.click(screen.getByRole('button', { name: 'Add provider' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('taken');

    await user.type(screen.getByLabelText('Display name'), 'x');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a pending "Saving…" label and disables the primary action', () => {
    h.createPending = true;
    renderPanel();
    const save = screen.getByRole('button', { name: 'Saving…' });
    expect(save).toBeDisabled();
  });
});

describe('SsoProviderPanel — credentials & policy controls', () => {
  it('toggles client-secret visibility between password and text', async () => {
    const user = userEvent.setup();
    renderPanel();
    const secret = screen.getByLabelText('Client secret');
    expect(secret).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show client secret' }));
    expect(secret).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide client secret' }));
    expect(secret).toHaveAttribute('type', 'password');
  });

  it('reveals the default-role select only when auto-create is on', async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(
      screen.queryByLabelText('Default role for auto-created members'),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('switch', { name: 'Auto-create members on first SSO sign-in' }),
    );
    expect(screen.getByLabelText('Default role for auto-created members')).toBeInTheDocument();
  });

  it('sends auto_create_members and the chosen default role on save', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByLabelText('Base URL'), 'https://id.example.com');
    await user.type(screen.getByLabelText('Realm'), 'main');
    await user.click(
      screen.getByRole('switch', { name: 'Auto-create members on first SSO sign-in' }),
    );
    await user.selectOptions(
      screen.getByLabelText('Default role for auto-created members'),
      'Admin',
    );
    await user.click(screen.getByRole('button', { name: 'Add provider' }));

    const body = h.createMutateAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(body.auto_create_members).toBe(true);
    // ROLE_ADMIN is a number; the select emits Admin.
    expect(typeof body.default_role).toBe('number');
  });

  it('exposes the shared redirect URI read-only and copies it to the clipboard', async () => {
    const user = userEvent.setup();
    renderPanel();
    const uri = screen.getByLabelText('Redirect URI (read-only)');
    expect(uri).toHaveAttribute('readonly');
    expect(uri).toHaveValue('https://app.example.com/api/v1/auth/oidc/callback/');

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    // The write resolves and the button flips to a "Copied" confirmation.
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('shows a deferred-redirect note when no redirect URI is known yet', () => {
    renderPanel({ sharedRedirectUri: '' });
    expect(screen.getByText(/Shown here after you add the first provider/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Redirect URI (read-only)')).not.toBeInTheDocument();
  });

  it('keeps enforced-SSO as an Enterprise upsell, never a functional switch', () => {
    renderPanel();
    expect(screen.getByText(/Password and SSO sign-in are both allowed/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Available in TruePPM Enterprise/i }),
    ).toBeInTheDocument();
  });

  it('closes without saving from the Cancel button and the header ✕', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel({ onClose });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Close provider panel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(h.createMutateAsync).not.toHaveBeenCalled();
  });
});

describe('SsoProviderPanel — Edit mode', () => {
  it('pre-fills the composition fields by decomposing the stored issuer', () => {
    renderPanel({ mode: 'edit', existing: KEYCLOAK });
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://id.acme.io');
    expect(screen.getByLabelText('Realm')).toHaveValue('main');
    expect(screen.getByLabelText('Client ID')).toHaveValue('trueppm-web');
    // The provider type is immutable on edit — rendered as static text, not a select.
    expect(screen.queryByRole('combobox', { name: 'Provider type' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Edit Acme SSO' })).toBeInTheDocument();
  });

  it('falls back to a raw editable Issuer URL when the stored issuer cannot be decomposed', () => {
    renderPanel({
      mode: 'edit',
      existing: { ...KEYCLOAK, server_url: 'https://weird.example.com/no-realms-here' },
    });
    const raw = screen.getByLabelText('Issuer URL');
    expect(raw).toHaveValue('https://weird.example.com/no-realms-here');
    // The decomposed fields are NOT shown in raw mode.
    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument();
  });

  it('updates by slug on save, sending the raw issuer edits through', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel({ mode: 'edit', existing: KEYCLOAK });
    await user.clear(screen.getByLabelText('Realm'));
    await user.type(screen.getByLabelText('Realm'), 'staging');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(h.updateMutateAsync).toHaveBeenCalledTimes(1);
    const arg = h.updateMutateAsync.mock.calls[0][0] as { slug: string; body: Record<string, unknown> };
    expect(arg.slug).toBe('keycloak');
    expect(arg.body.server_url).toBe('https://id.acme.io/realms/staging');
    expect(onClose).toHaveBeenCalled();
  });

  it('runs a connection test and reports a reachable issuer', async () => {
    h.testData = { ok: true };
    const user = userEvent.setup();
    renderPanel({ mode: 'edit', existing: KEYCLOAK });
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(h.testMutate).toHaveBeenCalledWith('keycloak');
    expect(screen.getByText('Reachable.')).toBeInTheDocument();
  });

  it('reports a failed connection test with the server detail', () => {
    h.testData = { ok: false, detail: 'discovery 404' };
    renderPanel({ mode: 'edit', existing: KEYCLOAK });
    expect(screen.getByText('discovery 404')).toBeInTheDocument();
  });

  it('shows a testing-in-progress label and disables the test button while pending', () => {
    h.testPending = true;
    renderPanel({ mode: 'edit', existing: KEYCLOAK });
    expect(screen.getByRole('button', { name: 'Testing…' })).toBeDisabled();
  });

  it('describes the GitHub API probe for an OAuth provider under test', () => {
    const gh: SsoProvider = {
      ...KEYCLOAK,
      slug: 'github',
      provider: 'github',
      kind: 'oauth',
      display_name: 'Acme GitHub',
      server_url: '',
      github_org: 'acme-inc',
      scopes: ['read:user', 'user:email'],
    };
    renderPanel({ mode: 'edit', existing: gh });
    expect(screen.getByText(/Checks that GitHub's API is reachable/)).toBeInTheDocument();
    // The org field is pre-filled from the stored provider.
    expect(screen.getByLabelText('Organization')).toHaveValue('acme-inc');
  });

  it('hides the Test-connection section in Add mode (nothing saved to probe)', () => {
    renderPanel();
    expect(screen.queryByText('Test connection')).not.toBeInTheDocument();
  });
});
