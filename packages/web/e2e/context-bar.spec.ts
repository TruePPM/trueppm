/**
 * E2E for the v2 context bar (shell slice 2, #1177, ADR-0127).
 *
 * Asserts the persistent context row: breadcrumb wayfinding (Workspace › Program ›
 * Project) and the rail "hide-to-context-bar" collapse driven by the ≡ toggle.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-ctxbar-00000000-0000-0000-0000-000000001177';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Context Bar Test Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    program_detail: { id: 'ctxbar-prog-1', name: 'Apollo Program' },
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
}

test.describe('v2 context bar (#1177)', () => {
  test('breadcrumb shows Workspace › Program › Project with the project as the current page', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const crumb = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumb).toBeVisible({ timeout: 10_000 });
    await expect(crumb.getByRole('link', { name: 'Workspace' })).toBeVisible();
    await expect(crumb.getByRole('link', { name: 'Apollo Program' })).toHaveAttribute(
      'href',
      '/programs/ctxbar-prog-1/overview',
    );
    // The project is the leaf — current page, not a link.
    await expect(crumb.getByText('Context Bar Test Project')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the ≡ toggle hides the rail and shows it again (hide-to-context-bar)', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    // The rail is a `complementary` landmark while shown; hiding it sets
    // aria-hidden + inert (width 0), so it leaves the accessibility tree.
    const rail = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(rail).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Hide navigation' }).click();
    await expect(rail).toHaveCount(0);

    await page.getByRole('button', { name: 'Show navigation' }).click();
    await expect(rail).toBeVisible();
  });

  test('presence avatars render in the context row on a project route, excluding self (#1180)', async ({
    page,
  }) => {
    await setup(page);
    // Override the default empty presence with collaborators. Self (e2e-user) is
    // included to prove the stack filters the current user out (#1180). Registered
    // before goto so the on-mount presence fetch resolves to this payload.
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

    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible({
      timeout: 10_000,
    });

    // The avatar stack is a single role="status" named by the online collaborators
    // ("Alice Adams, Bob Brown online"). Scope by a collaborator name so the
    // StatusBar's "N online" count region can't collide with it.
    const presence = page.getByRole('status', { name: /Alice Adams/ });
    await expect(presence).toBeVisible();
    await expect(presence).toHaveAccessibleName(/Bob Brown/);
    // Self is filtered out — never shown as a collaborator.
    await expect(presence).not.toHaveAccessibleName(/E2E User/);
  });

  test('a hidden rail stays hidden across reload (ADR-0127 persistence)', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const rail = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(rail).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Hide navigation' }).click();
    await expect(rail).toHaveCount(0);

    await page.reload();

    // The deliberate collapse is restored from localStorage, not reset to expanded.
    await expect(page.getByRole('button', { name: 'Show navigation' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(rail).toHaveCount(0);
  });
});
