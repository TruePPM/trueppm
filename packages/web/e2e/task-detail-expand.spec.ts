/**
 * Task detail expand-to-full-page (handoff "what changed" #13).
 *
 * The drawer's Expand control navigates to a full-page focus view of the same
 * task at /projects/:id/tasks/:taskId; the page renders the task title and the
 * registry-driven sections with a back link to the schedule.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-expand-0000-0000-0000-000000000013';
const TASK_ID = 'exp1';

const FIXTURE_PROJECTS = [
  { id: PROJECT_ID, name: 'Expand Project', description: '', start_date: '2026-04-01', calendar: 'default' },
];

const FIXTURE_TASKS = [
  {
    id: TASK_ID,
    wbs_path: '1',
    name: 'Foundation',
    early_start: '2026-04-05',
    early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

async function openDrawer(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/schedule`);
  const grid = page.getByRole('grid', { name: 'Task list' });
  await grid.getByText('Foundation', { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: /Foundation/ }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  return drawer;
}

test.describe('Task detail expand-to-full-page', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID, tasks: FIXTURE_TASKS });
  });

  test('Expand from the drawer opens the full-page task view', async ({ page }) => {
    const drawer = await openDrawer(page);
    await drawer.getByRole('button', { name: 'Expand to full page' }).click();

    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/tasks/${TASK_ID}`));
    await expect(page.getByRole('heading', { level: 1, name: /Foundation/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Back to schedule/ })).toBeVisible();
  });

  test('the full page is reachable directly by URL', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/tasks/${TASK_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: /Foundation/ })).toBeVisible({
      timeout: 5_000,
    });
  });
});
