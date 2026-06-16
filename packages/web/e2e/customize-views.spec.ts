import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll, type UserFixture } from './fixtures';

/**
 * Customize views — per-user nav visibility (issue #220, ADR-0139).
 *
 * The fixture project resolves to HYBRID, so every view tab is present and every
 * hideable view is toggleable. Golden path: a user with `schedule` hidden sees no
 * Schedule tab but can re-show it from the menu. Error/edge path: with nothing
 * hidden, Reset is disabled. Persistence (the PATCH body) is asserted directly.
 */

const PROJECT_ID = 'e2e-views-0000-0000-0000-000000000001';
const BASE_URL = `/projects/${PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Apollo Platform',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

function userWithHidden(hidden: string[]): UserFixture {
  return {
    id: 'e2e-user',
    username: 'e2euser',
    display_name: 'E2E User',
    initials: 'EU',
    email: 'e2e@example.com',
    default_landing: 'my_work',
    landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
    hidden_views: hidden,
  };
}

async function setup(page: import('@playwright/test').Page, hidden: string[] = []) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: PROJECT_ID,
    user: userWithHidden(hidden),
  });
}

test.describe('Customize views (ADR-0139)', () => {
  test('a personally-hidden view is absent from the bar but re-showable from the menu', async ({
    page,
  }) => {
    await setup(page, ['schedule']);
    await page.goto(`${BASE_URL}/board`);

    const nav = page.getByRole('navigation', { name: 'View' });
    await expect(nav.getByRole('link', { name: 'Board' })).toBeVisible();
    // Schedule is hidden by the personal preference.
    await expect(nav.getByRole('link', { name: 'Schedule' })).toHaveCount(0);
    // Overview (always-on) remains.
    await expect(nav.getByRole('link', { name: 'Overview' })).toBeVisible();

    // Open the Customize views menu — Schedule is listed, unchecked.
    await page.getByRole('button', { name: 'Customize views', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'Customize views' });
    await expect(menu).toBeVisible();
    const scheduleRow = menu.getByRole('menuitemcheckbox', { name: /Schedule/ });
    await expect(scheduleRow).toHaveAttribute('aria-checked', 'false');
    // Overview is shown but is not a toggle.
    await expect(menu.getByText('Overview')).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: /Overview/ })).toHaveCount(0);
  });

  test('toggling a view off PATCHes the hidden set to the profile', async ({ page }) => {
    await setup(page, []);
    await page.goto(`${BASE_URL}/board`);

    const nav = page.getByRole('navigation', { name: 'View' });
    await expect(nav.getByRole('link', { name: 'Schedule' })).toBeVisible();

    const patch = page.waitForRequest(
      (req) => req.url().includes('/auth/me/profile/') && req.method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Customize views', exact: true }).click();
    await page
      .getByRole('menu', { name: 'Customize views' })
      .getByRole('menuitemcheckbox', { name: /Schedule/ })
      .click();

    const body = (await patch).postDataJSON() as { hidden_views: string[] };
    expect(body.hidden_views).toContain('schedule');
  });

  test('Reset to default is disabled when nothing is hidden', async ({ page }) => {
    await setup(page, []);
    await page.goto(`${BASE_URL}/board`);
    await page.getByRole('button', { name: 'Customize views', exact: true }).click();
    const reset = page
      .getByRole('menu', { name: 'Customize views' })
      .getByRole('menuitem', { name: /Reset to .* default/ });
    await expect(reset).toBeVisible();
    await expect(reset).toBeDisabled();
  });
});
