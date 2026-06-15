import { test, expect } from '@playwright/test';

/**
 * Settings save contract E2E (#536).
 *
 * The SettingsShell save bar is gated on the active page's dirty state via
 * `useDirtyForm`. This spec exercises the cross-cutting contract on the one
 * page wired in this MR (Project General — name + description), and verifies
 * the nav guard:
 *   1. Save bar appears within 1 tick of input change.
 *   2. Discard reverts to the last-saved value.
 *   3. Save dispatches a real PATCH and clears the bar.
 *   4. Navigating to another settings page while dirty opens the confirm
 *      dialog; "Keep editing" preserves the edit, "Discard changes" navigates.
 */

const PROJECT_ID = 'e2e-settings-save-00000000-0000-0000-0000-000000000536';

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
  // #520 extended fields — every PATCH from the General page now carries the
  // full editable payload (one consolidated request rather than per-field
  // patches). Seed defaults so the save assertion below reflects the actual
  // shape posted by the page.
  code: '',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  timezone: '',
  default_view: 'SCHEDULE',
};

const FIXTURE_ME = {
  id: 'u-alice',
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
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

  // Catch-all for any unmocked /api/v1/* endpoint — return an empty 200 so the
  // app stays in a healthy state. Specific routes below override this because
  // Playwright matches the most recently added route first.
  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) });
    }
    return r.continue();
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
        task_count: 0, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0,
      }),
    }),
  );
  await page.route('**/api/v1/projects/*/attention/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/my-tasks/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  // Members endpoint is hit by the Access page after a discard navigation.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  // NotificationBell polls /me/notifications/; unmocked the static preview
  // server returns the SPA index.html and axios rejects the response with a
  // shape mismatch. Keep it quiet so the AppShell renders cleanly.
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

const ORIGINAL_NAME = FIXTURE_PROJECT.name;
const EDITED_NAME = 'Atlas Migration (renamed)';

test.describe('Settings save contract (#536)', () => {
  test('save bar is hidden until an input change', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    const nameInput = page.getByRole('textbox', { name: /project name/i });
    await expect(nameInput).toHaveValue(ORIGINAL_NAME);
    await expect(page.getByText('You have unsaved changes')).toBeHidden();
  });

  test('save bar appears within 1 tick of the first input change', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    const nameInput = page.getByRole('textbox', { name: /project name/i });
    await nameInput.fill(EDITED_NAME);
    await expect(page.getByText('You have unsaved changes')).toBeVisible();
    await expect(page.getByRole('button', { name: /save changes/i })).toBeEnabled();
  });

  test('Discard restores the last-saved value', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    const nameInput = page.getByRole('textbox', { name: /project name/i });
    await nameInput.fill(EDITED_NAME);
    await page.getByRole('button', { name: /^discard$/i }).click();
    await expect(nameInput).toHaveValue(ORIGINAL_NAME);
    await expect(page.getByText('You have unsaved changes')).toBeHidden();
  });

  test('Save dispatches PATCH /projects/:id and collapses the bar', async ({ page }) => {
    await setup(page);

    let patchBody: unknown = null;
    // Override the setup route — must also serve the GET because Playwright
    // routes are LIFO and `r.fallback()` is required to reach the next handler.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = r.request().postDataJSON();
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...FIXTURE_PROJECT, name: EDITED_NAME }),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FIXTURE_PROJECT),
      });
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    const nameInput = page.getByRole('textbox', { name: /project name/i });
    await nameInput.fill(EDITED_NAME);
    await page.getByRole('button', { name: /save changes/i }).click();

    // Page sends the full consolidated payload — #520 extended the surface
    // beyond name + description; use `toMatchObject` so additional fields
    // (code, health, visibility, timezone, default_view, calendar) on the
    // request don't make this contract brittle as the schema grows.
    await expect.poll(() => patchBody).toMatchObject({
      name: EDITED_NAME,
      description: FIXTURE_PROJECT.description,
    });
    await expect(page.getByText('You have unsaved changes')).toBeHidden();
  });

  test('navigating away while dirty opens the confirm-discard dialog', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    await page.getByRole('textbox', { name: /project name/i }).fill(EDITED_NAME);
    await page.getByRole('link', { name: 'Access' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Discard unsaved changes?' })).toBeVisible();
  });

  test('Keep editing closes the dialog and preserves the edit', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    const nameInput = page.getByRole('textbox', { name: /project name/i });
    await nameInput.fill(EDITED_NAME);
    await page.getByRole('link', { name: 'Access' }).click();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByRole('alertdialog')).toBeHidden();
    await expect(nameInput).toHaveValue(EDITED_NAME);
    // Still on the General page
    await expect(page).toHaveURL(/\/settings\/general$/);
  });

  test('Discard changes navigates to the destination and drops the edit', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/general`);
    await page.getByRole('textbox', { name: /project name/i }).fill(EDITED_NAME);
    await page.getByRole('link', { name: 'Access' }).click();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page).toHaveURL(/\/settings\/access$/);

    // Return to general; the original value should be back (server seed wins).
    await page.getByRole('link', { name: 'General' }).click();
    await expect(page.getByRole('textbox', { name: /project name/i })).toHaveValue(ORIGINAL_NAME);
  });

  test('stub pages disable form inputs (preview state for unwired API)', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);
    // Methodology page is apiReady=false — the methodology choice buttons are disabled.
    const inheritBtn = page.getByRole('button', { name: /inherit from workspace/i });
    await expect(inheritBtn).toBeDisabled();
  });
});
