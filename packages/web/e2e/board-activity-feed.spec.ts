/**
 * Board activity feed panel E2E (issue 1261 / ADR-0160).
 *
 * Golden path: toggle the feed from the toolbar → events list → click an event to open
 * its card drawer → filter by type re-queries the server. The read API (issue 325) is
 * mocked; rows render in a real browser (the virtualizer needs layout, unlike jsdom).
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-activity-0000-0000-0000-000000001261';
const BASE_URL = `/projects/${PROJECT_ID}`;

const TASKS = [
  {
    id: 'f1', wbs_path: '1', name: 'Build', early_start: '2026-01-05',
    early_finish: '2026-01-16', planned_start: '2026-01-05', duration: 10,
    percent_complete: 40, is_critical: false, is_milestone: false, is_summary: false,
    parent_id: null, status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false, linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'f2', wbs_path: '2', name: 'Refactor', early_start: '2026-01-06',
    early_finish: '2026-01-17', planned_start: '2026-01-06', duration: 10,
    percent_complete: 20, is_critical: false, is_milestone: false, is_summary: false,
    parent_id: null, status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false, linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

const ACTIVITY = {
  results: [
    {
      id: 'a1', event_type: 'task_updated', actor: 'Priya', actor_id: 'u-priya',
      timestamp: '2026-06-22T00:00:00Z', task_id: 'f1', task_name: 'Build', sprint_id: null,
      changes: [{ field: 'status', old: 'To Do', new: 'In Progress' }],
    },
    {
      id: 'a2', event_type: 'comment_added', actor: 'Alex', actor_id: 'u-alex',
      timestamp: '2026-06-21T00:00:00Z', task_id: 'f2', task_name: 'Refactor', sprint_id: null,
      changes: [],
    },
  ],
  next_until: null,
};

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [{ id: PROJECT_ID, name: 'Activity Project', description: '', start_date: '2026-01-01', calendar: 'default' }],
    projectId: PROJECT_ID,
    tasks: TASKS,
    statusSummary: { task_count: 2 },
  });
  const activityUrls: string[] = [];
  await page.route(`**/api/v1/projects/${PROJECT_ID}/board/activity**`, (route) => {
    activityUrls.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ACTIVITY) });
  });
  return activityUrls;
}

test.describe('Board activity feed', () => {
  test('toggles open from the toolbar and lists events', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Board activity feed' }).click();
    const panel = page.getByRole('complementary', { name: 'Board activity' });
    await expect(panel.getByRole('heading', { name: 'Activity' })).toBeVisible();
    // Each event row carries an "Open card" accessible name with the actor + verb.
    await expect(panel.getByRole('button', { name: /Priya updated Build/ })).toBeVisible();
    await expect(panel.getByText('status: To Do → In Progress')).toBeVisible();
  });

  test('clicking an event opens the related card drawer', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Board activity feed' }).click();

    await page.getByRole('button', { name: /Priya updated Build/ }).click();
    // The shared TaskDetailDrawer mounts as a dialog for the clicked card.
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('filtering by event type re-queries the server', async ({ page }) => {
    const activityUrls = await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Board activity feed' }).click();
    await expect(page.getByRole('button', { name: /Priya updated Build/ })).toBeVisible();

    await page.getByRole('button', { name: 'Cards', pressed: false }).click();
    // The Cards group maps to a comma-list of task_* event types on the `type` param.
    await expect
      .poll(() => activityUrls.some((u) => /type=task_created/.test(decodeURIComponent(u))))
      .toBe(true);
  });
});
