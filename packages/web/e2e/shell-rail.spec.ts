import { test, expect, type Page } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll, type ProjectFixture } from './fixtures';

/**
 * Left-rail 3-tier restructure E2E (#1642).
 *
 * The rail now renders the active project's methodology-adaptive grouped views in
 * its "This project" tier — read from the SAME composition the TopBar view bar uses
 * (`useGroupedProjectViews`), so `activity`/`assets` and every future view appear
 * automatically. Off a project the tier collapses to the pinned list, never a view
 * band. This spec covers:
 *   - the rail shows the project's grouped views (Plan/Deliver/Track/People) on
 *     /projects/:id/overview, scoped to the rail's OWN "Project views" nav so it
 *     never collides with the TopBar's "View" nav (which still renders until #1643);
 *   - clicking the rail's Activity and Assets rows navigates to those views;
 *   - off a project the rail shows pinned projects, not view groups.
 *
 * Every project-scoped endpoint the Overview page reads is mocked with its real
 * shape (via `setupApiMocks` + the blocked roll-up) so the page never crashes on an
 * unmocked object endpoint (#1190 lesson) and tears the rail out mid-interaction.
 */

const PROJECT_ID = 'e2e-rail-00000000-0000-0000-0000-000000000042';

const PROJECT: ProjectFixture = {
  id: PROJECT_ID,
  name: 'Rail Restructure Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  program: null,
  program_detail: null,
  health: 'ON_TRACK',
  methodology: 'HYBRID',
  // The rail (like the bar) reads the SERVER-RESOLVED preset — HYBRID surfaces
  // every group so Activity + Assets (TRACK) are present (the regression guard).
  effective_methodology: 'HYBRID',
};

async function setup(page: Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: [PROJECT], projectId: PROJECT_ID });
  // Overview page mounts useProjectBlocked (ADR-0124); an unmocked 401/404 here
  // trips the session-expired modal and blocks the rail interaction.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/blocked/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ project_id: PROJECT_ID, count: 0, blocked: [] }),
    }),
  );
  // My Work (rail You-card badge + the off-project landing page) reads this.
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [],
        next: null,
        previous: null,
        active_sprints: [],
        due_today_count: 0,
        server_version_high_water: 0,
        retro_action_items: [],
      }),
    }),
  );
}

test.describe('Left-rail 3-tier restructure (#1642)', () => {
  // The rail is the `complementary` landmark; scope every rail assertion to it so
  // its view links/groups never collide with the TopBar's identical "View" nav
  // (which still renders until #1643).
  const railOf = (page: Page) => page.getByRole('complementary', { name: 'Primary navigation' });

  test('the "This project" tier shows the grouped views on a project route', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    // Page-rendered signal: the rail's "This project" section header.
    const rail = railOf(page);
    await expect(rail.getByText('This project')).toBeVisible({ timeout: 10_000 });

    // The four methodology groups carry their accessible names (rule 172).
    await expect(rail.getByRole('group', { name: 'Plan views' })).toBeVisible();
    await expect(rail.getByRole('group', { name: 'Deliver views' })).toBeVisible();
    await expect(rail.getByRole('group', { name: 'Track views' })).toBeVisible();
    await expect(rail.getByRole('group', { name: 'People views' })).toBeVisible();

    // Overview leads; Activity + Assets (post-mockup TRACK views) are present.
    await expect(rail.getByRole('link', { name: 'Overview' })).toBeVisible();
    const track = rail.getByRole('group', { name: 'Track views' });
    await expect(track.getByRole('link', { name: 'Activity' })).toBeVisible();
    await expect(track.getByRole('link', { name: 'Assets' })).toBeVisible();
  });

  test('clicking the rail Activity row navigates to the activity view', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    const rail = railOf(page);
    await expect(rail.getByText('This project')).toBeVisible({ timeout: 10_000 });

    await rail.getByRole('link', { name: 'Activity' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/activity$`));
  });

  test('clicking the rail Assets row navigates to the assets view', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    const rail = railOf(page);
    await expect(rail.getByText('This project')).toBeVisible({ timeout: 10_000 });

    await rail.getByRole('link', { name: 'Assets' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/assets$`));
  });

  test('off a project the rail shows pinned projects, not view groups', async ({ page }) => {
    // Pin the project so the off-project tier has a row to show (the rail
    // persists pins under `trueppm.rail.pinned` as a bare id array).
    await page.addInitScript((id: string) => {
      localStorage.setItem('trueppm.rail.pinned', JSON.stringify([id]));
    }, PROJECT_ID);
    await setup(page);
    await page.goto('/me/work');

    // The rail (complementary landmark) renders the pinned band off a project.
    const rail = railOf(page);
    await expect(rail).toBeVisible({ timeout: 10_000 });
    await expect(rail.getByText('Pinned projects')).toBeVisible();
    // No "This project" view band / group landmarks off a project.
    await expect(rail.getByText('This project')).toHaveCount(0);
    await expect(rail.getByRole('group', { name: 'Track views' })).toHaveCount(0);
  });
});
