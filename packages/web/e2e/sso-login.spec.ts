import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Basic SSO (OIDC) — completion landing (#1392, ADR-0187).
 *
 * The OIDC callback 302s the browser to /auth/sso/complete. This spec covers the
 * terminal states of the flow:
 *  - golden path: the refresh cookie is set → the page mints the session and
 *    leaves the completion route into the app;
 *  - error path: `?error=sso_no_member` (verified at the IdP but not a member),
 *    the ADR §2 state 5.
 * The login-side handoff (email discover → RP login endpoint) is covered in
 * wave8-login.spec.ts.
 */

const pj = (data: unknown) => JSON.stringify(data);

test.describe('SSO completion', () => {
  test('golden path: mints the session and leaves the completion route', async ({ page }) => {
    await setupCatchAll(page);
    // The callback already set the refresh cookie; bootstrap exchanges it here.
    await page.route('**/api/v1/auth/token/refresh/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj({ access: 'e2e-access' }) }),
    );
    await page.route('**/api/v1/auth/me/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({
          id: 'u1',
          username: 'anna',
          display_name: 'Anna',
          initials: 'AN',
          email: 'anna@acme.io',
          role_context: 'unified',
          landing: { intent: 'my_work', path: '/me/work', resolved_by: 'role_policy' },
        }),
      }),
    );
    await page.route('**/api/v1/edition/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
    );

    const refreshFired = page.waitForRequest('**/api/v1/auth/token/refresh/');
    await page.goto('/auth/sso/complete');

    // The page owns one job: mint the session from the refresh cookie (flow
    // state 4). The "Identity verified" view is transient — with a fast mocked
    // refresh it is replaced by the app redirect before it can be asserted, so we
    // assert the observable outcome instead: the refresh fired…
    await refreshFired;
    // …and the page then hands off to the app, leaving the completion route.
    await page.waitForURL((url) => !url.pathname.startsWith('/auth/sso/complete'), {
      timeout: 10_000,
    });
  });

  test('error path: not-a-member shows the SSO_NO_MEMBER state', async ({ page }) => {
    await setupCatchAll(page);
    await page.goto('/auth/sso/complete?error=sso_no_member');

    await expect(page.getByRole('heading', { name: /not a member yet/i })).toBeVisible();
    await expect(page.getByText('SSO_NO_MEMBER')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  test('error path: a canceled sign-in shows an actionable message', async ({ page }) => {
    await setupCatchAll(page);
    await page.goto('/auth/sso/complete?error=access_denied');

    await expect(page.getByRole('heading', { name: 'Sign-in was canceled' })).toBeVisible();
  });

  test('error path: invalid_state renders the un-verifiable-link state', async ({ page }) => {
    await setupCatchAll(page);
    await page.goto('/auth/sso/complete?error=invalid_state');

    await expect(
      page.getByRole('heading', { name: 'Sign-in could not be verified' }),
    ).toBeVisible();
    await expect(page.getByTestId('sso-error-code')).toContainText('SSO_INVALID_STATE');
  });

  test('error path: sso_not_configured points the user back to password sign-in', async ({
    page,
  }) => {
    await setupCatchAll(page);
    await page.goto('/auth/sso/complete?error=sso_not_configured');

    await expect(page.getByRole('heading', { name: 'SSO is not configured' })).toBeVisible();
    await expect(page.getByTestId('sso-error-code')).toContainText('SSO_NOT_CONFIGURED');
  });

  test('error path: bootstrap failure (no refresh cookie) falls to the generic error', async ({
    page,
  }) => {
    await setupCatchAll(page);
    // No ?error in the URL → the page attempts to bootstrap. The refresh cookie
    // never arrived, so the token-refresh exchange fails and the page must show
    // the generic error rather than spinning forever.
    await page.route('**/api/v1/auth/token/refresh/', (r) =>
      r.fulfill({
        status: 401,
        contentType: 'application/json',
        body: pj({ detail: 'No valid refresh token found.' }),
      }),
    );
    await page.goto('/auth/sso/complete');

    await expect(page.getByRole('heading', { name: "We couldn't complete sign-in" })).toBeVisible();
    await expect(page.getByTestId('sso-error-code')).toContainText('SSO_ERROR');
  });
});
