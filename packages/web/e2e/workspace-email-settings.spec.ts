import { test, expect, type Page } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Workspace → Settings → Email & SMTP — writable transport config (#712, ADR-0211).
 *
 * Golden path: switch to Custom SMTP, fill the transport, save (validate-before-
 * persist succeeds), then send a test email. Error path: a save that fails
 * transport validation (400) keeps the entered values and shows the inline
 * "Transport validation failed" alert.
 */

const EMAIL_GET = {
  transport_mode: 'cloud',
  host: '',
  port: 587,
  security: 'tls',
  username: '',
  password_is_set: false,
  from_name: 'TrueScope',
  from_email: 'notify@truescope.io',
  reply_to: '',
  dkim_selector: '',
  max_recipients: 50,
  throttle_per_min: 0,
  bounce_webhook_url: '',
  can_edit: true,
  configured_via: 'environment',
  host_configured: false,
};

// The consolidated settings page mounts every section at once, so the General
// section's /workspace/ hook runs even on the email route. Mock it with its real
// object shape so General renders cleanly (the catch-all list shape would crash it).
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
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ id: 'u1', username: 'alice', display_name: 'Alice', initials: 'AL', email: 'a@x.io' }),
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
}

test.describe('Workspace Email & SMTP — writable', () => {
  test('golden path: configure Custom SMTP, save, and send a test email', async ({ page }) => {
    await setup(page);
    // GET returns the config; PUT succeeds (validate-before-persist passes).
    await page.route('**/api/v1/workspace/email-settings/', (r) => {
      if (r.request().method() === 'PUT') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({
            ...EMAIL_GET,
            transport_mode: 'smtp',
            host: 'mail.truescope.io',
            password_is_set: true,
          }),
        });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(EMAIL_GET) });
    });
    await page.route('**/api/v1/workspace/email-settings/send-test/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ sent: true, recipient: 'a@x.io' }),
      }),
    );

    await page.goto('/settings/email');
    await expect(page.getByRole('heading', { name: 'Email & SMTP' })).toBeVisible();

    // Reveal the SMTP fields, fill the transport.
    await page.getByRole('radio', { name: /Custom SMTP/ }).check();
    await page.getByLabel('SMTP host').fill('mail.truescope.io');
    await page.getByLabel('SMTP username').fill('postmaster');
    await page.getByLabel('Password', { exact: true }).fill('s3cret');

    // Save via the shell save-bar.
    await page.getByRole('button', { name: 'Save changes' }).click();

    // Send-test is enabled once the form is clean; sending shows the success line.
    const sendBtn = page.getByRole('button', { name: 'Send test email' });
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();
    await expect(page.getByText(/Sent — check your inbox/i)).toBeVisible();
  });

  test('error path: a failed transport validation keeps values and shows the inline alert', async ({
    page,
  }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/email-settings/', (r) => {
      if (r.request().method() === 'PUT') {
        return r.fulfill({
          status: 400,
          contentType: 'application/json',
          body: pj({ non_field_errors: ['Could not connect to the mail server.'] }),
        });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(EMAIL_GET) });
    });

    await page.goto('/settings/email');
    await expect(page.getByRole('heading', { name: 'Email & SMTP' })).toBeVisible();

    await page.getByRole('radio', { name: /Custom SMTP/ }).check();
    await page.getByLabel('SMTP host').fill('bad.host.example');
    await page.getByLabel('SMTP username').fill('u');
    await page.getByLabel('Password', { exact: true }).fill('s3cret');
    await page.getByRole('button', { name: 'Save changes' }).click();

    const email = page.locator('[data-settings-section="email"]');
    await expect(email.getByText('Transport validation failed')).toBeVisible();
    await expect(email.getByText('Could not connect to the mail server.')).toBeVisible();
    // Values are preserved — the host the admin typed is still in the field.
    await expect(page.getByLabel('SMTP host')).toHaveValue('bad.host.example');
  });
});
