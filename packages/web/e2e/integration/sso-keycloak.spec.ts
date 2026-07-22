import { test, expect, request as playwrightRequest } from '@playwright/test';

/**
 * Integration — real OIDC handshake against a live Keycloak (#2274).
 *
 * The only test in the suite that completes an actual OIDC login end-to-end
 * against a real identity provider. Every other SSO test mocks at the internal
 * egress seam (pytest) or `page.route` (web:e2e), so the real discovery-document
 * parse, PKCE/state/nonce round-trip, token exchange, and JWKS-verified ID token
 * are never exercised — this closes that gap and catches drift when Keycloak or
 * allauth changes shape.
 *
 * Runs only in the nightly `sso:integration` CI job, which stands up Keycloak
 * (baked realm `trueppm-ci`, confidential client `trueppm-web`, one verified
 * user) as a service and seeds the matching TruePPM provider via
 * `manage.py seed_sso_keycloak`.
 *
 * The TruePPM provider auto-creates members, so the Keycloak user becomes a
 * workspace member on first login — exercising the full resolve/create path, not
 * just the handshake.
 */

// Django origin (not the Vite baseURL): the login flow starts at the API, which
// 302s the browser to Keycloak and back to the callback.
const API_ORIGIN = process.env['API_URL'] ?? 'http://127.0.0.1:8000';

// Keycloak test-user credentials — must match .gitlab/keycloak/trueppm-realm.json.
const KC_USERNAME = process.env['SSO_KEYCLOAK_TEST_USERNAME'] ?? 'sso-user';
const KC_PASSWORD = process.env['SSO_KEYCLOAK_TEST_PASSWORD'] ?? 'keycloak-user-pw';

// Workspace-admin seeded by seed_sso_keycloak, used for the admin-only
// test-connection probe. Password is shared with the integration fixtures.
const ADMIN_EMAIL = process.env['SSO_ADMIN_EMAIL'] ?? 'sso-admin@trueppm-ci.test';
const ADMIN_PASSWORD = process.env['INTEGRATION_USER_PASSWORD'] ?? 'ci-integration-pw';

test.describe('Integration — Keycloak OIDC', () => {
  test('completes a real login handshake and enters the app', async ({ page }) => {
    // Start the flow at the API. Django sets the browser-binding state cookie and
    // 302s to Keycloak's authorization endpoint (from the live discovery doc).
    await page.goto(`${API_ORIGIN}/api/v1/auth/oidc/login?provider=keycloak`);

    // We are now on Keycloak's login page — fill the real form and submit.
    await expect(page.locator('#username')).toBeVisible({ timeout: 30_000 });
    await page.locator('#username').fill(KC_USERNAME);
    await page.locator('#password').fill(KC_PASSWORD);
    await page.locator('#kc-login').click();

    // Keycloak 302s to the callback → Django validates the ID token (JWKS over the
    // SSRF-guarded egress), auto-creates the member, sets the refresh cookie, and
    // 302s to /auth/sso/complete, which bootstraps the session and enters the app.
    await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible({
      timeout: 30_000,
    });
    // We must NOT be sitting on the SSO error state.
    await expect(page.getByTestId('sso-error-code')).toHaveCount(0);
  });

  test('admin test-connection succeeds against the live realm', async ({ playwright }) => {
    const ctx = await playwrightRequest.newContext({ baseURL: API_ORIGIN });
    try {
      // Password-login as the seeded workspace admin to obtain an access token.
      const tokenResp = await ctx.post('/api/v1/auth/token/', {
        data: { username: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
      expect(tokenResp.ok()).toBeTruthy();
      const { access } = (await tokenResp.json()) as { access: string };
      expect(access).toBeTruthy();

      // Probe the live Keycloak provider — fetches discovery (cache-bypassed) and
      // confirms JWKS reachability through the egress guard.
      const probe = await ctx.post('/api/v1/workspace/sso/providers/keycloak/test-connection/', {
        headers: { Authorization: `Bearer ${access}` },
      });
      expect(probe.ok()).toBeTruthy();
      const body = (await probe.json()) as {
        ok: boolean;
        endpoints?: { token_endpoint?: string; jwks_uri?: string };
      };
      expect(body.ok).toBe(true);
      expect(body.endpoints?.token_endpoint).toContain('/realms/trueppm-ci/');
      expect(body.endpoints?.jwks_uri).toBeTruthy();
    } finally {
      await ctx.dispose();
    }
  });
});
