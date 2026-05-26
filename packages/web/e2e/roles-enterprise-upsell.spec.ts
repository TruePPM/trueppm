import { test, expect, type Page } from '@playwright/test';

/**
 * Workspace → Settings → Roles & permissions: Enterprise upsell affordance (#541).
 *
 * Enterprise-only capability rows (Manage SSO, View audit log, …) carry an "EE"
 * badge that links to the Enterprise page, so an evaluator can tell OSS rows
 * from Enterprise rows without leaving the matrix. The badge is suppressed when
 * the running edition is Enterprise (the capabilities are then available).
 */

const pj = (data: unknown) => JSON.stringify(data);

async function setup(page: Page, edition: 'community' | 'enterprise') {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  // Catch-all first (Playwright matches last-registered first); specific routes win.
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
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition }) }),
  );
}

test.describe('Roles matrix — Enterprise upsell (#541)', () => {
  test('badges every Enterprise-only row and links it to the Enterprise page (community)', async ({ page }) => {
    await setup(page, 'community');
    await page.goto('/settings/roles');

    await expect(page.getByRole('heading', { name: 'Roles & permissions' })).toBeVisible();

    const badges = page.getByRole('link', { name: /Available in TruePPM Enterprise/i });
    await expect(badges).toHaveCount(5);
    await expect(badges.first()).toHaveAttribute('href', 'https://trueppm.com/enterprise');
  });

  test('hides the EE badges when running the Enterprise edition', async ({ page }) => {
    await setup(page, 'enterprise');
    await page.goto('/settings/roles');

    await expect(page.getByRole('heading', { name: 'Roles & permissions' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Available in TruePPM Enterprise/i })).toHaveCount(0);
  });
});
