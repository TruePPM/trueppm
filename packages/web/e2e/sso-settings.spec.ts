import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Workspace → Settings → Single sign-on — multi-provider admin config
 * (#2108, ADR-0517, supersedes #1392).
 *
 * Covers the empty state (no providers → Add CTA opens the panel), the
 * configured list (live status, provider row, redirect URI + scopes in the edit
 * panel), test connection, save (PUT), and remove (styled confirm → DELETE). The
 * consolidated settings page mounts every section at once, so the General
 * /workspace/ hook and /auth/me/ must be mocked with their real object shapes
 * alongside the /workspace/sso/providers/ collection.
 */

const pj = (data: unknown) => JSON.stringify(data);

const WORKSPACE = {
  name: 'TrueScope Aerospace',
  subdomain: 'truescope',
  timezone: 'America/Los_Angeles',
  fiscal_year_start_month: 1,
  fiscal_year_start_day: 1,
  fiscal_year_start_display: 'January 1',
  work_week: [true, true, true, true, true, false, false],
  default_project_view: 'Board',
  allow_guests: true,
  public_sharing: false,
  iteration_label: 'Sprint',
  iteration_label_override_policy: 'suggest',
  mc_history_enabled: true,
  mc_history_retention_cap: 100,
  mc_history_attribution_audience: 'ADMIN_OWNER',
  mc_history_override_policy: 'suggest',
};

const KEYCLOAK = {
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
  redirect_uri: 'https://app.truescope.io/api/v1/auth/oidc/callback/',
  created_at: '2026-07-11T00:00:00Z',
  updated_at: '2026-07-11T00:00:00Z',
};

async function setup(page: Page, providers: unknown[]) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        id: 'u1',
        username: 'alice',
        display_name: 'Alice',
        initials: 'AL',
        email: 'a@x.io',
        can_access_admin_settings: true,
      }),
    }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/workspace/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) }),
  );
  // The collection returns a plain array (not paginated).
  await page.route('**/api/v1/workspace/sso/providers/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(providers) }),
  );
}

test.describe('Workspace Single sign-on — admin (multi-provider)', () => {
  test('empty state: no providers → Add CTA opens the provider panel', async ({ page }) => {
    await setup(page, []);
    await page.goto('/settings#sso');

    await expect(page.getByRole('heading', { name: 'Single sign-on' })).toBeVisible();
    await expect(page.getByText('No identity provider connected')).toBeVisible();
    await expect(page.getByText('SSO sign-in is not enabled yet')).toBeVisible();

    await page.getByRole('button', { name: 'Add provider' }).click();
    // The panel opens on Keycloak (a derived, two-field provider).
    await expect(page.getByLabel('Provider type', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Base URL')).toBeVisible();
    await expect(page.getByLabel('Realm')).toBeVisible();
    await expect(page.getByLabel('Client ID', { exact: true })).toBeVisible();
  });

  test('configured: live status and a provider row', async ({ page }) => {
    await setup(page, [KEYCLOAK]);
    await page.goto('/settings#sso');

    await expect(page.getByText('SSO sign-in is live')).toBeVisible();
    await expect(page.getByText('Acme SSO')).toBeVisible();
    await expect(page.getByText('Keycloak · OIDC')).toBeVisible();
    // The consolidated settings page mounts other sections that also render an
    // "Enabled" label, so scope the provider status pill to the SSO section.
    await expect(
      page
        .getByRole('region', { name: 'Single sign-on', exact: true })
        .getByText('Enabled', { exact: true }),
    ).toBeVisible();
  });

  test('edit panel: redirect URI (copy) and fixed OSS scopes', async ({ page }) => {
    await setup(page, [KEYCLOAK]);
    await page.goto('/settings#sso');

    await expect(page.getByText('SSO sign-in is live')).toBeVisible();
    await page.getByRole('button', { name: 'Edit' }).click();

    await expect(page.getByLabel('Redirect URI (read-only)')).toHaveValue(KEYCLOAK.redirect_uri);
    // Scopes are fixed to the OSS set — no groups scope.
    await expect(page.getByText('openid', { exact: true })).toBeVisible();
    await expect(page.getByText('profile', { exact: true })).toBeVisible();
  });

  test('test connection: a reachable issuer reports success inline', async ({ page }) => {
    await setup(page, [KEYCLOAK]);
    await page.route('**/api/v1/workspace/sso/providers/keycloak/test-connection/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ok: true, issuer: KEYCLOAK.server_url }),
      }),
    );
    await page.goto('/settings#sso');

    await expect(page.getByText('SSO sign-in is live')).toBeVisible();
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByText('✓ Reachable.')).toBeVisible();
  });

  test('save: editing the display name persists via PUT to the slug item', async ({ page }) => {
    await setup(page, [KEYCLOAK]);
    let putBody: Record<string, unknown> | null = null;
    // Registered AFTER the collection route so this item-specific handler wins
    // (last-registered wins; reverse-order match).
    await page.route('**/api/v1/workspace/sso/providers/keycloak/', (r) => {
      const req = r.request();
      if (req.method() === 'PUT') {
        putBody = req.postDataJSON() as Record<string, unknown>;
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({ ...KEYCLOAK, display_name: 'Renamed SSO' }),
        });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(KEYCLOAK) });
    });
    await page.goto('/settings#sso');

    await expect(page.getByText('SSO sign-in is live')).toBeVisible();
    await page.getByRole('button', { name: 'Edit' }).click();

    const displayName = page.getByLabel('Display name', { exact: true });
    await displayName.fill('Renamed SSO');
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect.poll(() => putBody).not.toBeNull();
    expect(putBody).toMatchObject({ display_name: 'Renamed SSO' });
  });

  test('remove: the styled confirm dialog issues DELETE on the slug item', async ({ page }) => {
    await setup(page, [KEYCLOAK]);
    let deleteFired = false;
    await page.route('**/api/v1/workspace/sso/providers/keycloak/', (r) => {
      const req = r.request();
      if (req.method() === 'DELETE') {
        deleteFired = true;
        return r.fulfill({ status: 204, body: '' });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(KEYCLOAK) });
    });
    await page.goto('/settings#sso');

    await expect(page.getByText('SSO sign-in is live')).toBeVisible();

    await page.getByRole('button', { name: 'Remove' }).click();
    const dialog = page.getByRole('alertdialog', { name: /Remove Acme SSO\?/ });
    await expect(dialog).toBeVisible();

    // Cancel first — DELETE must not fire.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(deleteFired).toBe(false);

    // Re-open and confirm.
    await page.getByRole('button', { name: 'Remove' }).click();
    await page
      .getByRole('alertdialog', { name: /Remove Acme SSO\?/ })
      .getByRole('button', { name: 'Remove provider' })
      .click();

    await expect.poll(() => deleteFired).toBe(true);
  });
});
