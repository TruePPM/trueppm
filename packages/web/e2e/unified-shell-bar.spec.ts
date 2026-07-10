/**
 * E2E for the v2 unified shell bar (#1204, ADR-0134; amended by #1643/ADR-0203).
 * After #1643 the bar's left region is a location switcher (Program › Project ›
 * Leaf) — the breadcrumb + in-chrome ProjectSwitcher are gone and the view-tab
 * strip lives in the left rail. Asserts: the location switcher wayfinding, the rail
 * re-open ≡ toggle + persistence, presence in the bar, and that the pinned right
 * cluster stays visible at lg widths.
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
  test('the location switcher shows Project › Leaf wayfinding in the bar (#1643)', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    // The location switcher is the bar's wayfinding — always shown (no longer the
    // rail-coupled adaptive breadcrumb). Scope it to the banner landmark.
    const bar = page.getByRole('banner');
    const location = bar.getByRole('navigation', { name: 'Location' });
    await expect(location).toBeVisible({ timeout: 10_000 });

    // The active project is shown, and the leaf is the current view as a plain
    // aria-current label (never a dropdown — the rail owns view switching).
    await expect(location.getByText('Shell Bar Test Project')).toBeVisible();
    await expect(location.getByText('Overview')).toHaveAttribute('aria-current', 'page');
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

    // The view nav (now in the left rail, #1643) is present, and the always-on
    // right-cluster anchor (account chip) remains within the viewport. The chip
    // self-identifies by the signed-in user's name (#1792) — locatable by that
    // accessible name, never a generic "User menu".
    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible({ timeout: 10_000 });
    const userMenu = page.getByRole('button', { name: 'Account — E2E User' }).last();
    await expect(userMenu).toBeInViewport();
  });
});
