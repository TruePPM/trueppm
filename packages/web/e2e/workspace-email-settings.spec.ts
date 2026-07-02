import { test, expect, type Page } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Workspace → Settings → Email & SMTP (read-only status, #639, ADR-0084 §5).
 *
 * Golden path: the configured transport + From identity render. Error path: a
 * failing status endpoint shows the Retry affordance.
 */

const EMAIL_STATUS = {
  transport: 'smtp',
  host: 'mail.truescope.io',
  host_configured: true,
  port: 587,
  use_tls: true,
  use_ssl: false,
  from_email: 'notify@truescope.io',
  configured_via: 'environment',
};

// The consolidated settings page (#1248) mounts every section at once, so the
// General section's /workspace/ hook runs even on the email-anchored route. The
// catch-all returns a list shape for that object endpoint, which makes General
// render its own error + "Retry", colliding with the email section's Retry.
// Mock /workspace/ with its real object shape so General renders cleanly.
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

const pj = (data: unknown) => JSON.stringify(data);

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  // Catch-all first (Playwright matches last-registered first) so no unmocked
  // call 401s into the session-expired loop; specific routes below win.
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ id: 'u1', username: 'alice', display_name: 'Alice', initials: 'AL', email: 'a@x.io' }),
    }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/workspace/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) }),
  );
}

test.describe('Workspace Email & SMTP — read-only status', () => {
  test('shows the configured transport and From identity', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/email-settings/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(EMAIL_STATUS) }),
    );

    await page.goto('/settings/email');

    await expect(page.getByRole('heading', { name: 'Email & SMTP' })).toBeVisible();
    await expect(page.getByText('mail.truescope.io')).toBeVisible();
    await expect(page.getByText('notify@truescope.io')).toBeVisible();
    await expect(page.getByText(/not yet wired/i)).toBeVisible();
  });

  test('shows an error + Retry when the status endpoint fails', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/email-settings/', (r) =>
      r.fulfill({ status: 500, contentType: 'application/json', body: pj({ detail: 'boom' }) }),
    );

    await page.goto('/settings/email');

    // Scope to the email section — other sections render their own Retry buttons.
    const email = page.locator('[data-settings-section="email"]');
    await expect(email.getByText(/Couldn.t load email settings/i)).toBeVisible();
    await expect(email.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});
