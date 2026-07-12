import { test, expect, type Page } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Workspace → Settings → Single sign-on — admin OIDC config (#1392, ADR-0187).
 *
 * Covers the empty state (no provider connected → connect CTA) and the configured
 * state (live status, copy-able redirect URI, disable action). The consolidated
 * settings page mounts every section at once, so the General /workspace/ hook and
 * /auth/me/ must be mocked with their real object shapes alongside /workspace/sso/.
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
  mc_history_override_policy: 'allow',
};

const BLANK_SSO = {
  enabled: false,
  display_name: '',
  issuer_url: '',
  client_id: '',
  scopes: ['openid', 'email', 'profile'],
  allowed_email_domains: [],
  auto_create_members: false,
  default_role: 100,
  allow_password_signin: true,
  allow_password_signin_enforced: false,
  secret_set: false,
  redirect_uri: 'https://app.truescope.io/api/v1/auth/oidc/callback/',
  created_at: '2026-07-11T00:00:00Z',
  updated_at: '2026-07-11T00:00:00Z',
};

const CONFIGURED_SSO = {
  ...BLANK_SSO,
  enabled: true,
  display_name: 'Acme SSO',
  issuer_url: 'https://id.acme.io',
  client_id: 'trueppm-web',
  allowed_email_domains: ['acme.io'],
  auto_create_members: true,
  secret_set: true,
};

async function setup(page: Page, sso: unknown) {
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
  await page.route('**/api/v1/workspace/sso/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(sso) }),
  );
}

test.describe('Workspace Single sign-on — admin', () => {
  test('empty state: no provider connected → connect CTA reveals the form', async ({ page }) => {
    await setup(page, BLANK_SSO);
    await page.goto('/settings#sso');

    await expect(page.getByRole('heading', { name: 'Single sign-on' })).toBeVisible();
    await expect(page.getByText('No identity provider connected')).toBeVisible();

    await page.getByRole('button', { name: 'Connect OIDC provider' }).click();
    await expect(page.getByLabel('Issuer URL')).toBeVisible();
    await expect(page.getByLabel('Client ID')).toBeVisible();
  });

  test('configured state: live status, redirect URI, and disable action', async ({ page }) => {
    await setup(page, CONFIGURED_SSO);
    await page.goto('/settings#sso');

    await expect(page.getByText('OIDC sign-in is live')).toBeVisible();
    await expect(page.getByLabel('Redirect URI (read-only)')).toHaveValue(
      CONFIGURED_SSO.redirect_uri,
    );
    await expect(page.getByRole('button', { name: 'Disable SSO' })).toBeVisible();
    // Scopes are fixed to the OSS set — no groups scope.
    await expect(page.getByText('openid email profile')).toBeVisible();
  });
});
