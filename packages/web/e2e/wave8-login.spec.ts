import { test, expect } from '@playwright/test';

/**
 * Wave 8 — Login screen redesign (#215).
 *
 * Covers the two-column layout, marketing panel, real SSO entry (#1392), and
 * remember-me checkbox. Auth flow happy-path and error-path are covered in
 * auth.spec.ts; the SSO completion flow in sso-login.spec.ts.
 */

const AUTH_TOKEN_URL = '**/api/v1/auth/token/';

test.describe('Wave 8 — Login screen', () => {
  test('renders two-column layout with brand and hero copy', async ({ page }) => {
    await page.goto('/login');

    // Duotone mark + two-color wordmark (brand v1.0); accessible name on the lockup.
    await expect(page.getByLabel('TruePPM')).toBeVisible();

    // Hero copy
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.getByText('Sign in to keep your launch on schedule.')).toBeVisible();
  });

  test('email field accepts email input and password field is obscured', async ({ page }) => {
    await page.goto('/login');

    const emailInput = page.getByLabel('Email');
    const passwordInput = page.getByLabel('Password', { exact: true });

    await expect(emailInput).toHaveAttribute('type', 'email');
    await expect(passwordInput).toHaveAttribute('type', 'password');
  });

  test('remember-me checkbox is present and toggleable', async ({ page }) => {
    await page.goto('/login');

    const checkbox = page.getByLabel('Keep me signed in for 30 days');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();

    await checkbox.click();
    await expect(checkbox).toBeChecked();
  });

  test('Forgot? control is present below the password input', async ({ page }) => {
    await page.goto('/login');

    // Now a real link into the self-service reset flow (#765), not a "coming soon" button.
    const forgot = page.getByRole('link', { name: 'Forgot password?' });
    await expect(forgot).toBeVisible();
    await expect(forgot).toHaveAttribute('href', '/forgot-password');
  });

  test('Tab order goes Email → Password → Forgot? → Keep me signed in → Sign in (Forgot? does not interrupt the credentials)', async ({ page }) => {
    await page.goto('/login');

    // Fill the form so the Sign in button isn't disabled (disabled buttons
    // aren't focusable, which would mask whether tab actually reached them).
    const email = page.getByLabel('Email');
    await email.fill('user@example.com');
    await page.getByLabel('Password', { exact: true }).fill('password123');

    await email.focus();
    await expect(email).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password', { exact: true })).toBeFocused();

    // The control sits below the password input — Forgot? comes AFTER the
    // password in the tab order, not between Email and Password.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByLabel(/Keep me signed in/)).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused();
  });

  test('a sign-in button per enabled provider + open-source chip (basic SSO is OSS, #2108)', async ({
    page,
  }) => {
    await page.route('**/api/v1/auth/oidc/discover/**', (route) =>
      route.fulfill({
        status: 200,
        json: {
          provider_present: true,
          providers: [
            { slug: 'keycloak', display_name: 'Keycloak' },
            { slug: 'github', display_name: 'GitHub' },
          ],
        },
      }),
    );
    await page.goto('/login');

    await expect(page.getByRole('button', { name: 'Continue with Keycloak' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
    // The chip corrects the prior "SSO available in Enterprise tier" mislabel.
    await expect(page.getByText(/Open-source core/i)).toBeVisible();
  });

  test('no SSO section is shown when no provider is configured', async ({ page }) => {
    await page.route('**/api/v1/auth/oidc/discover/**', (route) =>
      route.fulfill({ status: 200, json: { provider_present: false, providers: [] } }),
    );
    await page.goto('/login');

    // Password form is present; no provider buttons and no dangling OR divider.
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Continue with/i })).toHaveCount(0);
  });

  test('SSO hands off to the provider-scoped RP login endpoint on click', async ({ page }) => {
    await page.route('**/api/v1/auth/oidc/discover/**', (route) =>
      route.fulfill({
        status: 200,
        json: { provider_present: true, providers: [{ slug: 'keycloak', display_name: 'Keycloak' }] },
      }),
    );
    // The handoff is a top-level navigation to the RP login endpoint (which would
    // 302 to the IdP in production); stub it so the browser lands somewhere benign.
    // The `**` after `login` is required — the ?provider= query would otherwise
    // break the glob match.
    await page.route('**/api/v1/auth/oidc/login**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>idp</body></html>' }),
    );
    await page.goto('/login');

    await page.getByRole('button', { name: 'Continue with Keycloak' }).click();

    await page.waitForURL('**/api/v1/auth/oidc/login**');
    expect(page.url()).toContain('/api/v1/auth/oidc/login?provider=keycloak');
  });

  test('marketing panel shows headline and build info', async ({ page }) => {
    await page.goto('/login');

    // The panel is hidden on narrow viewports — test at desktop width.
    await page.setViewportSize({ width: 1440, height: 900 });

    await expect(page.getByRole('heading', { name: 'Schedules that hold under pressure.' })).toBeVisible();
    // Status pill
    await expect(page.getByText(/CPM v.*live/)).toBeVisible();
    // Footer build info
    await expect(page.getByText(/build .* · status: operational/)).toBeVisible();
  });

  test('marketing panel is hidden below md breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/login');

    // The panel has `hidden md:flex` — it should not be visible on mobile
    const panel = page.getByText('Schedules that hold under pressure.');
    await expect(panel).toBeHidden();
  });

  test('successful login posts remember_me flag when checkbox is checked', async ({ page }) => {
    let capturedBody: Record<string, unknown> = {};

    await page.route(AUTH_TOKEN_URL, async (route) => {
      capturedBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access: 'mock-access', refresh: 'mock-refresh' }),
      });
    });
    await page.route('**/api/v1/projects/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
    await page.route('**/api/v1/projects/*/presence/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    );
    await page.route('**/api/v1/projects/*/status-summary/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          task_count: 0, critical_path_count: 0, monte_carlo_p80: null,
          at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
          last_saved: null, recalculated_at: null,
        }),
      }),
    );

    await page.goto('/login');
    await page.getByLabel('Keep me signed in for 30 days').check();
    await page.getByLabel('Email').fill('anna@example.com');
    await page.getByLabel('Password', { exact: true }).fill('secret');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).not.toHaveURL(/\/login/, { timeout: 5_000 });
    expect(capturedBody['remember_me']).toBe(true);
  });
});
