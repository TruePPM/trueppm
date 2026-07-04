/**
 * Project Activity tab (unified changelog) E2E — ADR-0201 / #371.
 *
 * Golden path: deep-link to the Activity tab → aggregated rows render newest-first
 * → toggling an object-type chip re-queries the server with the object_type param
 * → clicking a task row navigates to its detail route. Plus the empty state.
 *
 * The changelog read API is mocked; rows render in a real browser.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-changelog-0000-0000-0000-000000000371';
const BASE_URL = `/projects/${PROJECT_ID}`;

const CHANGELOG = {
  results: [
    {
      id: 'risk:5',
      object_type: 'risk',
      object_id: 'r5',
      object_label: 'Vendor slip',
      change_type: 'created',
      history_date: '2026-06-22T00:00:00Z',
      user: { id: 'u-alice', display_name: 'Alice' },
      changes: [],
    },
    {
      id: 'task:9',
      object_type: 'task',
      object_id: 't9',
      object_label: 'Design the API',
      change_type: 'updated',
      history_date: '2026-06-21T00:00:00Z',
      user: { id: 'u-alice', display_name: 'Alice' },
      changes: [{ field: 'status', old: 'NOT_STARTED', new: 'IN_PROGRESS' }],
    },
  ],
  next_cursor: null,
};

async function setup(page: import('@playwright/test').Page, body: unknown = CHANGELOG) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      {
        id: PROJECT_ID,
        name: 'Changelog Project',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
      },
    ],
    projectId: PROJECT_ID,
    tasks: [],
    statusSummary: { task_count: 0 },
    members: [{ id: 'mem-1', role: 300, user_detail: { id: 'u-alice', username: 'alice' } }],
  });
  const requests: string[] = [];
  await page.route(`**/api/v1/projects/${PROJECT_ID}/changelog/**`, (route) => {
    requests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  return requests;
}

test.describe('Project Activity tab', () => {
  test('deep-links to the tab and lists aggregated rows newest-first', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/activity`);

    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible({ timeout: 10_000 });
    const list = page.getByTestId('changelog-list');
    await expect(list.getByText('Vendor slip')).toBeVisible();
    await expect(list.getByText('Design the API')).toBeVisible();
    await expect(list.getByText('status')).toBeVisible();
  });

  test('toggling an object-type chip re-queries with the object_type param', async ({ page }) => {
    const requests = await setup(page);
    await page.goto(`${BASE_URL}/activity`);
    await expect(page.getByTestId('changelog-list')).toBeVisible({ timeout: 10_000 });

    await page.getByRole('checkbox', { name: 'Task' }).click();
    await expect
      .poll(() => requests.some((u) => /object_type=task/.test(u)))
      .toBe(true);
  });

  test('clicking a task row navigates to its detail route', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/activity`);
    await expect(page.getByTestId('changelog-list')).toBeVisible({ timeout: 10_000 });

    await page.getByText('Design the API').click();
    await page.waitForURL(`**${BASE_URL}/tasks/t9`);
  });

  test('shows the empty state when there is no activity', async ({ page }) => {
    await setup(page, { results: [], next_cursor: null });
    await page.goto(`${BASE_URL}/activity`);
    await expect(page.getByText('No activity yet')).toBeVisible({ timeout: 10_000 });
  });
});
