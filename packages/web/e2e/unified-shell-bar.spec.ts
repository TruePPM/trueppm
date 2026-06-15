/**
 * E2E for the v2 unified shell bar (#1204, ADR-0134) — the one-bar consolidation of
 * the former context row + view row. Asserts: adaptive identity (the breadcrumb shows
 * only when the rail is hidden on desktop), the rail re-open ≡ toggle + persistence,
 * presence in the bar, and that the pinned right cluster stays visible at lg widths
 * (the tab strip scrolls; it never pushes the right cluster off-screen).
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-shellbar-0000-0000-0000-000000001204';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Shell Bar Test Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    program_detail: { id: 'shellbar-prog-1', name: 'Apollo Program' },
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
}

test.describe('v2 unified shell bar (#1204)', () => {
  test('adaptive identity: breadcrumb is hidden while the rail is open, shown when the rail is hidden', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    // The shell bar is the banner landmark; scope the breadcrumb to it so an
    // in-content breadcrumb can't collide.
    const bar = page.getByRole('banner');
    const crumb = bar.getByRole('navigation', { name: 'Breadcrumb' });

    // Rail open (default on desktop): the identity duplicates the rail, so it is
    // display:none-hidden (ADR-0134 adaptive identity).
    await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(crumb).toBeHidden();

    // Hide the rail: the identity now appears (it is the only wayfinding left).
    await page.getByRole('button', { name: 'Hide navigation' }).click();
    await expect(crumb).toBeVisible();
    await expect(crumb.getByRole('link', { name: 'Workspace' })).toBeVisible();
    await expect(crumb.getByRole('link', { name: 'Apollo Program' })).toHaveAttribute(
      'href',
      '/programs/shellbar-prog-1/overview',
    );
    await expect(crumb.getByText('Shell Bar Test Project')).toHaveAttribute('aria-current', 'page');
  });

  test('the ≡ toggle hides the rail and shows it again, and the hidden state persists across reload', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const rail = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(rail).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Hide navigation' }).click();
    await expect(rail).toHaveCount(0);

    await page.getByRole('button', { name: 'Show navigation' }).click();
    await expect(rail).toBeVisible();

    // Hide again, then reload: the deliberate collapse is restored from localStorage.
    await page.getByRole('button', { name: 'Hide navigation' }).click();
    await expect(rail).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Show navigation' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(rail).toHaveCount(0);
  });

  test('presence avatars render in the bar on a project route, excluding self (#1180)', async ({
    page,
  }) => {
    await setup(page);
    await page.route('**/api/v1/projects/*/presence/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { user_id: 'e2e-user', display_name: 'E2E User' },
          { user_id: 'collab-alice', display_name: 'Alice Adams' },
          { user_id: 'collab-bob', display_name: 'Bob Brown' },
        ]),
      }),
    );
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const presence = page.getByRole('status', { name: /Alice Adams/ });
    await expect(presence).toBeVisible({ timeout: 10_000 });
    await expect(presence).toHaveAccessibleName(/Bob Brown/);
    await expect(presence).not.toHaveAccessibleName(/E2E User/);
  });

  test('the right cluster stays visible at lg — the tab strip scrolls, it does not push chrome off-screen', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/board`);

    // The view nav is present, and the always-on right-cluster anchor (user menu)
    // remains within the viewport even with the full grouped tab strip.
    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible({ timeout: 10_000 });
    const userMenu = page.getByRole('button', { name: /user menu/i }).last();
    await expect(userMenu).toBeInViewport();
  });
});
