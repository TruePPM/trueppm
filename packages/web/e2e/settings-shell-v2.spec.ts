import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Shell v2 Settings restyle (#4800) behind `?ff=shell_v2`: the dirty-state save bar
 * names what changed, Cmd/Ctrl+S saves, and leaving with unsaved edits asks first.
 * Mocks mirror settings-shell-ux.spec.ts (Project > General).
 */

const PROJECT_ID = 'e2e-shell-v2-settings-00000000-0000-0000-0000-000000004800';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Atlas Migration',
  description: 'Original description.',
  start_date: '2026-01-01',
  calendar: 'default',
  estimation_mode: 'open',
  agile_features: false,
  methodology: 'HYBRID',
};

const FIXTURE_ME = {
  id: 'u-alice',
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
  // Admin+ in at least one project (ADR-0122). `RequireAdminSettings` no longer
  // admits on a verdict-less /auth/me (#3350), and `can_access_admin_settings` is a
  // declared MeSerializer field, so a payload omitting it was never representable.
  can_access_admin_settings: true,
};

type Page = import('@playwright/test').Page;

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

  const pj = (data: unknown) => JSON.stringify(data);

  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => {
    if (r.request().method() === 'PATCH') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...FIXTURE_PROJECT, name: 'Atlas Migration (renamed)' }),
      });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) });
  });
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        task_count: 0,
        health_band: 'on_track',
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
      }),
    }),
  );
  await page.route('**/api/v1/projects/*/attention/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ items: [] }) }),
  );
  await page.route('**/api/v1/projects/*/my-tasks/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ tasks: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  // useCurrentUserRole's `?self=true` read resolves the Project General page to
  // Admin (role 400) so its fields stay editable under the #1084 role gate.
  // Registered after the roster route → wins Playwright's LIFO match for self.
  await page.route(
    (url) =>
      url.pathname.endsWith(`/projects/${PROJECT_ID}/members/`) &&
      url.searchParams.get('self') === 'true',
    (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj([{ id: 'self', role: 400 }]),
      }),
  );
  await page.route('**/api/v1/me/notifications/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/me/notification-preferences/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
}


const V2 = '?ff=shell_v2';

test.describe('Settings under shell v2 (#4800)', () => {
  test('edit shows the save bar naming the section; Ctrl+S saves it', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general${V2}`);

    await expect(page.getByTestId('settings-save-bar')).toBeHidden();
    const nameInput = page.getByRole('textbox', { name: /project name/i });
    await nameInput.fill('Atlas Migration (renamed)');

    const bar = page.getByTestId('settings-save-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Unsaved changes in');

    await nameInput.press('Control+s');
    await expect(page.getByTestId('settings-save-bar')).toBeHidden();
    await expect(page.getByTestId('settings-saved-footer')).toBeVisible();
  });

  test('leaving with unsaved edits asks first; Keep editing stays', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general${V2}`);

    await page.getByRole('textbox', { name: /project name/i }).fill('Dirty name');
    await page.getByRole('button', { name: 'Personal', exact: true }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /keep editing/i }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/settings`));
  });

  test('v1 (flag off) has no Personal segment', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Personal', exact: true })).toHaveCount(0);
  });
});
