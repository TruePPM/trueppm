import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Settings → Schedule (issue #2682).
 *
 * Build mode is on by default on desktop now (the `schedule_build_mode_v1`
 * flag was deleted, ADR-0054's removal criteria met) — this page no longer
 * offers a toggle, only a reference link into the keyboard cheatsheet.
 */

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
  mc_history_attribution_audience: 'admin_owner',
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

  // Catch-all first (Playwright matches last-registered first) so no unmocked
  // call 401s into the session-expired loop; specific routes below win. Every
  // other settings section is contained by its SettingsSectionErrorBoundary, so
  // a 404 there does not tear down the app — but mock the object-shaped reads the
  // General section makes so it renders cleanly next to the Schedule section.
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
  await page.route('**/api/v1/programs/', (r) =>
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

// The Schedule section anchor — the "page rendered" signal we gate interactions
// on, so we never click chrome before the consolidated page has laid out.
const scheduleSection = (page: Page) => page.locator('[data-settings-section="schedule"]');

test.describe('Settings → Schedule (#2682)', () => {
  test('golden path: no toggle, keyboard shortcuts cheatsheet opens from the link', async ({
    page,
  }) => {
    await setup(page);
    await page.goto('/settings/schedule');

    const section = scheduleSection(page);
    await expect(section.getByRole('heading', { name: 'Schedule' })).toBeVisible();

    // No toggle and no Beta chip — build mode is not opt-in anymore.
    await expect(section.getByRole('switch')).toHaveCount(0);
    await expect(section.getByText('Beta')).toHaveCount(0);

    await section.getByRole('button', { name: 'View keyboard shortcuts' }).click();
    await expect(page.getByRole('dialog', { name: 'Schedule shortcuts' })).toBeVisible();
    await page.getByRole('button', { name: 'Close shortcuts' }).click();
    await expect(page.getByRole('dialog', { name: 'Schedule shortcuts' })).toHaveCount(0);
  });
});
