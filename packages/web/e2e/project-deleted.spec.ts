/**
 * Deleted-project not-found gate (#1111).
 *
 * After a project is soft-deleted its API endpoints 404 (the queryset and the
 * overview/attention views filter is_deleted=False). ProjectShell gates every
 * project route on the project detail query and shows a single honest
 * "not found" state instead of an empty "zombie" overview shell.
 *
 * Here we simulate the post-delete server state by returning 404 for the
 * project detail and assert the gate renders ProjectNotFound with a way back.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const DELETED_PROJECT_ID = 'e2e-deleted-0000-0000-0000-000000001111';

test.describe('Deleted project', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projectId: DELETED_PROJECT_ID,
      projects: [
        {
          id: DELETED_PROJECT_ID,
          name: 'Removed Project',
          description: '',
          start_date: '2026-01-01',
          calendar: 'default',
        },
      ],
    });
    // Simulate the soft-deleted server state: the detail endpoint now 404s.
    // Registered AFTER setupApiMocks so it wins (Playwright matches LIFO).
    await page.route(`**/api/v1/projects/${DELETED_PROJECT_ID}/`, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Not found.' }),
      }),
    );
  });

  test('shows the not-found state instead of an empty overview shell', async ({ page }) => {
    await page.goto(`/projects/${DELETED_PROJECT_ID}/overview`);

    await expect(page.getByRole('heading', { name: /isn.t available/i })).toBeVisible();
    await expect(page.getByText(/may have been deleted/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /back to your projects/i })).toBeVisible();
  });
});

/**
 * Revoked-access gate (#2040).
 *
 * Losing access mid-session (a revoked membership, or a bookmark to a project
 * you were removed from) is indistinguishable from deletion at the API boundary
 * — the detail endpoint is queryset-scoped to the caller's memberships, so a
 * non-member's project 404s. A 403 can still arrive on an edge path, so
 * ProjectShell treats both as "unavailable" and shows the same honest terminal
 * state (with a way home) rather than a retry treadmill against a resource that
 * will never load.
 */
test.describe('Revoked project access', () => {
  const REVOKED_PROJECT_ID = 'e2e-revoked-0000-0000-0000-000000002040';

  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projectId: REVOKED_PROJECT_ID,
      projects: [
        {
          id: REVOKED_PROJECT_ID,
          name: 'No Longer Mine',
          description: '',
          start_date: '2026-01-01',
          calendar: 'default',
        },
      ],
    });
    // Simulate a revoked membership: the detail endpoint 403s. Registered AFTER
    // setupApiMocks so it wins (Playwright matches LIFO).
    await page.route(`**/api/v1/projects/${REVOKED_PROJECT_ID}/`, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'You must be a member of this project.' }),
      }),
    );
  });

  test('shows the unavailable state (with a way home) instead of a retry treadmill', async ({
    page,
  }) => {
    await page.goto(`/projects/${REVOKED_PROJECT_ID}/overview`);

    await expect(page.getByRole('heading', { name: /isn.t available/i })).toBeVisible();
    await expect(page.getByText(/no longer have access/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /back to your projects/i })).toBeVisible();
  });
});
