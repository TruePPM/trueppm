import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Settings → Schedule → Build mode (beta) toggle (issue 1633).
 *
 * Golden path: a hosted user with no dev tooling navigates to Settings → Schedule,
 * flips Build mode on, and the `schedule_build_mode_v1` flag is persisted to
 * localStorage — the same key the Schedule view reads to unlock the keyboard-first
 * build surface. Reachability is proven two ways: the flag survives a reload, and
 * the keyboard cheatsheet becomes openable from the settings row.
 */

const FLAG_KEY = 'trueppm.featureFlags';
const FLAG = 'schedule_build_mode_v1';

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

test.describe('Settings → Schedule → Build mode toggle (issue 1633)', () => {
  test('golden path: enabling Build mode persists the flag and unlocks the cheatsheet', async ({
    page,
  }) => {
    await setup(page);
    await page.goto('/settings/schedule');

    // Gate on the section being rendered before touching the toggle.
    const section = scheduleSection(page);
    await expect(section.getByRole('heading', { name: 'Schedule' })).toBeVisible();
    await expect(section.getByText('Beta')).toBeVisible();

    const toggle = section.getByRole('switch', { name: 'Build mode (beta)' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    // No cheatsheet link before the flag is on.
    await expect(
      section.getByRole('button', { name: 'View keyboard shortcuts' }),
    ).toHaveCount(0);

    // Flip it on.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Persisted to the same localStorage key the Schedule view reads.
    const stored = await page.evaluate((key) => localStorage.getItem(key), FLAG_KEY);
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored as string)[FLAG]).toBe(true);

    // Reachability #1: the cheatsheet (the Build mode help surface) opens.
    await section.getByRole('button', { name: 'View keyboard shortcuts' }).click();
    await expect(page.getByRole('dialog', { name: 'Schedule shortcuts' })).toBeVisible();
    await page.getByRole('button', { name: 'Close shortcuts' }).click();
    await expect(page.getByRole('dialog', { name: 'Schedule shortcuts' })).toHaveCount(0);

    // Reachability #2: the flag survives a fresh app boot (reload).
    await page.reload();
    const sectionAfter = scheduleSection(page);
    await expect(sectionAfter.getByRole('heading', { name: 'Schedule' })).toBeVisible();
    await expect(
      sectionAfter.getByRole('switch', { name: 'Build mode (beta)' }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  test('reflects an already-enabled flag and can turn it back off', async ({ page }) => {
    await setup(page);
    await page.addInitScript(
      ([key, flag]) => {
        localStorage.setItem(key, JSON.stringify({ [flag]: true }));
      },
      [FLAG_KEY, FLAG] as const,
    );
    await page.goto('/settings/schedule');

    const section = scheduleSection(page);
    await expect(section.getByRole('heading', { name: 'Schedule' })).toBeVisible();

    const toggle = section.getByRole('switch', { name: 'Build mode (beta)' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Turn it off.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    const stored = await page.evaluate((key) => localStorage.getItem(key), FLAG_KEY);
    expect(JSON.parse(stored as string)[FLAG]).toBe(false);
  });
});
