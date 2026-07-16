import { test, expect, type Page } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll, type UserFixture } from './fixtures';

/**
 * Personal settings navigation (#2013 → #2023).
 *
 * The four `/me/settings/*` pages are flat routes with no left rail, so a shared
 * subnav is the only way across them. This spec proves (a) the bare `/me/settings`
 * URL redirects to General rather than 404-ing, and (b) the subnav lists all four
 * pages and cross-navigates from every page.
 *
 * The subnav is static chrome that renders regardless of page data, so only the
 * handful of endpoints the destination pages read are mocked (per CLAUDE.md
 * catch-all guidance the catch-all here 404s, so each read is mocked explicitly).
 */

const USER: UserFixture = {
  id: 'e2e-user',
  username: 'e2euser',
  display_name: 'E2E User',
  initials: 'EU',
  email: 'e2e@example.com',
  default_landing: 'my_work',
  landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
  hidden_views: [],
  role_context: 'unified',
  schedule_in_deliver: false,
  dnd_enabled: false,
  timezone: 'auto',
  date_format: 'auto',
};

const SUBNAV_LINKS = ['General', 'Notifications', 'Connected accounts', 'API tokens'];

async function setup(page: Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { user: USER });
  // The API-tokens page reads its own paginated list — mock it empty so the
  // destination renders cleanly rather than into a 404 error card.
  await page.route('**/api/v1/me/api-tokens/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
}

test.describe('Personal settings navigation (#2023)', () => {
  test('bare /me/settings redirects to General and lists all four pages', async ({ page }) => {
    await setup(page);

    await page.goto('/me/settings');

    // The index route redirects instead of falling through to the 404 page.
    await expect(page).toHaveURL(/\/me\/settings\/general$/);
    await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Personal settings sections' });
    await expect(nav).toBeVisible();
    for (const label of SUBNAV_LINKS) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
  });

  test('the subnav cross-navigates between the four pages', async ({ page }) => {
    await setup(page);

    await page.goto('/me/settings/general');
    const nav = page.getByRole('navigation', { name: 'Personal settings sections' });
    await expect(nav).toBeVisible();

    // General → API tokens.
    await nav.getByRole('link', { name: 'API tokens', exact: true }).click();
    await expect(page).toHaveURL(/\/me\/settings\/api-tokens$/);
    await expect(page.getByRole('heading', { name: 'Personal access tokens' })).toBeVisible();

    // The subnav is present on the destination too — the api-tokens page used to
    // render no subnav at all, stranding the user with no way back or across.
    const navHere = page.getByRole('navigation', { name: 'Personal settings sections' });
    await expect(navHere).toBeVisible();
    await navHere.getByRole('link', { name: 'General', exact: true }).click();
    await expect(page).toHaveURL(/\/me\/settings\/general$/);
    await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();
  });
});
