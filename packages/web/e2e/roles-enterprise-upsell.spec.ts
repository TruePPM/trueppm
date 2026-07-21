import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Workspace → Settings → Roles & permissions: Enterprise upsell affordance (#541).
 *
 * Enterprise-only capability rows (View audit log, Manage integrations, Manage
 * billing) carry an "EE" badge that links to the Enterprise page, so an
 * evaluator can tell OSS rows from Enterprise rows without leaving the matrix.
 * Basic OIDC/OAuth SSO and workspace data export ship in the OSS core, so
 * "Manage SSO" and "Export workspace data" are NOT badged (#2165). The badge is
 * suppressed when the running edition is Enterprise (the capabilities are then
 * available).
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
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        id: 'u1',
        username: 'alice',
        display_name: 'Alice',
        initials: 'AL',
        email: 'a@x.io',
      }),
    }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition }) }),
  );
}

test.describe('Roles matrix — Enterprise upsell (#541)', () => {
  test('badges every Enterprise-only row and links it to the Enterprise page (community)', async ({
    page,
  }) => {
    await setup(page, 'community');
    await page.goto('/settings/roles');

    const roles = page.locator('[data-settings-section="roles"]');
    await expect(roles.getByRole('heading', { name: 'Roles & permissions' })).toBeVisible();

    // Scope to the matrix, not the whole roles section: the section now also
    // carries a custom-roles upsell caption (#1649) whose badge links to the same
    // Enterprise page, and on the consolidated settings page (#1248) every section
    // mounts at once. This count is specifically the Enterprise-only matrix rows.
    const matrix = roles.getByTestId('roles-matrix');
    const badges = matrix.getByRole('link', { name: /Available in TruePPM Enterprise/i });
    await expect(badges).toHaveCount(3);
    await expect(badges.first()).toHaveAttribute('href', 'https://trueppm.com/enterprise');

    // Basic SSO is OSS (#2165): the "Manage SSO" row header carries no EE badge.
    const ssoRow = matrix.getByRole('rowheader', { name: /Manage SSO/i });
    await expect(ssoRow.getByRole('link')).toHaveCount(0);

    // WCAG 1.3.1 (#2165): the matrix is a real table an AT user can navigate —
    // a column header per role and a row header per capability.
    await expect(matrix.getByRole('table')).toBeVisible();
    for (const role of ['Viewer', 'Member', 'Scheduler', 'Admin', 'Owner']) {
      await expect(matrix.getByRole('columnheader', { name: role })).toBeVisible();
    }
    await expect(matrix.getByRole('rowheader', { name: 'View tasks' })).toBeVisible();

    // The custom-roles upsell caption (#1649) is the reachable boundary affordance
    // replacing the old stub banner — its EE badge links out too.
    await expect(roles.getByText(/Need custom roles/i)).toBeVisible();
    await expect(
      roles
        .getByText(/Need custom roles/i)
        .getByRole('link', { name: /Available in TruePPM Enterprise/i }),
    ).toHaveAttribute('href', 'https://trueppm.com/enterprise');
  });

  test('hides the EE badges when running the Enterprise edition', async ({ page }) => {
    await setup(page, 'enterprise');
    await page.goto('/settings/roles');

    const roles = page.locator('[data-settings-section="roles"]');
    await expect(roles.getByRole('heading', { name: 'Roles & permissions' })).toBeVisible();
    await expect(roles.getByRole('link', { name: /Available in TruePPM Enterprise/i })).toHaveCount(
      0,
    );
  });
});
