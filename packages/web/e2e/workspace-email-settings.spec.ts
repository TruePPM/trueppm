import { test, expect, type Page } from '@playwright/test';

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
  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
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
    await expect(page.getByText(/configured via environment/i)).toBeVisible();
  });

  test('shows an error + Retry when the status endpoint fails', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/email-settings/', (r) =>
      r.fulfill({ status: 500, contentType: 'application/json', body: pj({ detail: 'boom' }) }),
    );

    await page.goto('/settings/email');

    await expect(page.getByText(/Couldn.t load email settings/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});
