import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Project Settings → Integrations → Git-event automation E2E (#1257, backend #329).
 *
 * Covers the project-admin config UI on top of the ADR-0158 receiver:
 *   - golden path: section renders with toggle + webhook URL + secret action
 *   - generate-secret one-time reveal
 *   - error state (scoped to the section, since the consolidated settings page
 *     mounts every section and siblings render their own "Retry")
 */

const PROJECT_ID = 'e2e-gitauto-00000000-0000-0000-0000-000000001257';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Git Automation Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  methodology: 'HYBRID',
};

const FIXTURE_ME = {
  id: 'user-alice',
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const WEBHOOK_URL = `https://app.example.com/api/v1/integrations/projects/${PROJECT_ID}/git-webhook/`;

const CONFIG_NO_SECRET = {
  enabled: false,
  secret_set: false,
  webhook_url: WEBHOOK_URL,
  configured_by: null,
  secret_set_at: null,
  updated_at: '2026-06-21T00:00:00Z',
};

const pj = (data: unknown) => JSON.stringify(data);
const page1 = (results: unknown[]) =>
  pj({ count: results.length, next: null, previous: null, results });

async function commonRoutes(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // 401-guard catch-all (registered first; specific routes below win — last wins).
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: page1([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) }),
  );
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  // Role gate: useCurrentUserRole reads /members/?self=true and expects an ARRAY.
  // Return an Owner row (role 400 ≥ ADMIN) so the admin-only section renders.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([{ id: 'mem-1', role: 400 }]),
    }),
  );
}

test.describe('Git-event automation settings', () => {
  test('renders the section with toggle, webhook URL, and secret action', async ({ page }) => {
    await commonRoutes(page);
    await page.route(`**/api/v1/integrations/projects/${PROJECT_ID}/git-automation/`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(CONFIG_NO_SECRET) }),
    );

    await page.goto(`/projects/${PROJECT_ID}/settings/integrations`);

    const section = page.locator('[data-testid="git-automation-manager"]');
    await expect(section.getByRole('heading', { name: 'Git-event automation' })).toBeVisible();
    await expect(
      section.getByRole('switch', { name: 'Enable Git-event automation' }),
    ).toBeVisible();
    await expect(section.getByRole('textbox', { name: 'Webhook URL' })).toHaveValue(WEBHOOK_URL);
    await expect(section.getByRole('button', { name: 'Generate secret' })).toBeVisible();
    await expect(section.getByText(/Pull requests/i)).toBeVisible();
  });

  test('generates a secret and reveals it exactly once', async ({ page }) => {
    await commonRoutes(page);
    await page.route(`**/api/v1/integrations/projects/${PROJECT_ID}/git-automation/`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(CONFIG_NO_SECRET) }),
    );
    await page.route(
      `**/api/v1/integrations/projects/${PROJECT_ID}/git-automation/rotate-secret/`,
      (r) =>
        r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: pj({
            secret: 'tppm_THE_RAW_WEBHOOK_SECRET',
            webhook_url: WEBHOOK_URL,
            secret_set_at: '2026-06-21T00:00:00Z',
          }),
        }),
    );

    await page.goto(`/projects/${PROJECT_ID}/settings/integrations`);
    const section = page.locator('[data-testid="git-automation-manager"]');
    await expect(section.getByRole('heading', { name: 'Git-event automation' })).toBeVisible();

    await section.getByRole('button', { name: 'Generate secret' }).click();
    const dialog = page.getByRole('dialog', { name: /Generate webhook secret/i });
    await dialog.getByRole('button', { name: 'Generate secret' }).click();

    await expect(page.getByText(/only time you.ll see this secret/i)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'New webhook secret' })).toHaveValue(
      'tppm_THE_RAW_WEBHOOK_SECRET',
    );
  });

  test('shows an error + Retry when the config load fails', async ({ page }) => {
    await commonRoutes(page);
    await page.route(`**/api/v1/integrations/projects/${PROJECT_ID}/git-automation/`, (r) =>
      r.fulfill({ status: 500, contentType: 'application/json', body: pj({ detail: 'boom' }) }),
    );

    await page.goto(`/projects/${PROJECT_ID}/settings/integrations`);

    const section = page.locator('[data-testid="git-automation-manager"]');
    await expect(section.getByText(/Couldn.t load Git-event automation/i)).toBeVisible();
    await expect(section.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});
