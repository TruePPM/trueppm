import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, type UserFixture } from './fixtures';

/**
 * Customize views — per-user nav visibility (issue #220, ADR-0139). Since #1680 the
 * Customize-views control lives in the left rail's "This project" band (its gear
 * beside the header), not the top bar — but its accessible name ("Customize views")
 * and menu are unchanged, so these name-based selectors are location-agnostic.
 *
 * The fixture project resolves to HYBRID, so every view is present and every
 * hideable view is toggleable. Golden path: a user with `schedule` hidden sees no
 * Schedule row but can re-show it from the menu. Error/edge path: with nothing
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
  test('a personally-hidden view is absent from the rail nav but re-showable from the menu', async ({
    page,
  }) => {
    await setup(page, ['schedule']);
    await page.goto(`${BASE_URL}/board`);

    const nav = page.getByRole('navigation', { name: 'View' });
    await expect(nav.getByRole('link', { name: 'Board', exact: true })).toBeVisible();
    // Schedule is hidden by the personal preference.
    await expect(nav.getByRole('link', { name: 'Schedule' })).toHaveCount(0);
    // Dashboard (always-on) remains — it is a TRACK member now, not a standalone row,
    // so the always-on guarantee rests on the authored vocabulary (ADR-0942 §6) rather
    // than on standing outside every band.
    await expect(nav.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible();

    // Open the Customize views menu — Schedule is listed, unchecked.
    await page.getByRole('button', { name: 'Customize views', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'Customize views' });
    await expect(menu).toBeVisible();
    const scheduleRow = menu.getByRole('menuitemcheckbox', { name: 'Schedule', exact: true });
    await expect(scheduleRow).toHaveAttribute('aria-checked', 'false');
    // Both always-on views are shown, and neither is a toggle — offering one would
    // PATCH a key the server rejects with a 400.
    await expect(menu.getByText('Dashboard', { exact: true })).toBeVisible();
    await expect(menu.getByText('Settings', { exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: /Dashboard/ })).toHaveCount(0);
    await expect(
      menu.getByRole('menuitemcheckbox', { name: 'Settings', exact: true }),
    ).toHaveCount(0);
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
      .getByRole('menuitemcheckbox', { name: 'Schedule', exact: true })
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

  // --- the Schedule-in-Deliver placement opt-in is retired (ADR-0942 §3, #3137) ---

  test('offers no placement opt-in, and Schedule has exactly one home in the rail', async ({
    page,
  }) => {
    // HYBRID fixture, nothing hidden — the methodology where the opt-in used to apply.
    // ADR-0942 §3: a nav item listed twice is two objects to the person using it, so the
    // control and its server field are both gone.
    await setup(page, []);
    await page.goto(`${BASE_URL}/board`);

    // Gate on the nav having rendered before touching the menu, so the interaction is
    // not racing the page's data reads.
    const nav = page.getByRole('navigation', { name: 'View' });
    await expect(nav.getByRole('link', { name: 'Schedule' })).toBeVisible();

    // Schedule appears once, in PLAN, and nowhere else.
    await expect(nav.getByRole('link', { name: 'Schedule' })).toHaveCount(1);
    const plan = nav.getByRole('group', { name: 'Plan views' });
    await expect(plan.getByRole('link', { name: 'Schedule' })).toBeVisible();
    const deliver = nav.getByRole('group', { name: 'Deliver views' });
    await expect(deliver.getByRole('link', { name: 'Schedule' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Customize views', exact: true }).click();
    const menu = page.getByRole('menu', { name: 'Customize views' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: /under Deliver/ })).toHaveCount(0);
    await expect(menu.getByText('Placement')).toHaveCount(0);
  });

});
