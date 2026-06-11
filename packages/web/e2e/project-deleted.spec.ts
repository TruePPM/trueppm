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
import { test, expect } from '@playwright/test';
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
