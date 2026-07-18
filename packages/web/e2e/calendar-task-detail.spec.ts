import { test, expect } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

/**
 * Calendar task-detail banner (issue 1613).
 *
 * Clicking a calendar chip opens an inline banner showing the task's name,
 * dates, status, and assignees — not the raw task UUID — with a link to the
 * full task detail route. Close dismisses it.
 */

const PROJECT_ID = 'e2e-cal-00000000-0000-0000-0000-000000000013';
// Anchor the calendar to a fixed month so the fixture task is always visible.
const CALENDAR_URL = `/projects/${PROJECT_ID}/calendar?calAnchor=2026-03-01`;

const FIXTURE_TASKS = [
  {
    id: 'cal-task-1',
    wbs_path: '1',
    name: 'Foundation Pour',
    early_start: '2026-03-10',
    early_finish: '2026-03-13',
    planned_start: '2026-03-10',
    duration: 4,
    percent_complete: 40,
    is_critical: false,
    status: 'IN_PROGRESS',
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    assignments: [{ resource_id: 'r1', resource_name: 'Ada Lovelace', units: 1 }],
  },
];

test.describe('Calendar task-detail banner', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projectId: PROJECT_ID,
      projects: [{ id: PROJECT_ID, name: 'Calendar Project', start_date: '2026-03-01' }],
      tasks: FIXTURE_TASKS,
    });
    await page.goto(CALENDAR_URL);
    // Gate on the calendar chrome being rendered before interacting.
    await expect(page.getByRole('group', { name: 'Calendar view mode' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('clicking a chip opens the banner with task detail, not a UUID', async ({ page }) => {
    await page.getByRole('button', { name: 'Foundation Pour' }).click();

    const banner = page.getByRole('region', { name: 'Task detail: Foundation Pour' });
    await expect(banner).toBeVisible();
    // Rich detail is shown.
    await expect(banner.getByText('Foundation Pour')).toBeVisible();
    await expect(banner.getByText('In progress')).toBeVisible();
    await expect(banner.getByText('Mar 10 – Mar 13')).toBeVisible();
    await expect(banner.getByText('Ada Lovelace')).toBeVisible();
    // The raw UUID is never rendered.
    await expect(banner.getByText('cal-task-1')).toHaveCount(0);
    // Link points at the full task detail route.
    await expect(banner.getByRole('link', { name: 'Open full detail' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/tasks/cal-task-1`,
    );
  });

  test('Close dismisses the banner', async ({ page }) => {
    await page.getByRole('button', { name: 'Foundation Pour' }).click();
    const banner = page.getByRole('region', { name: 'Task detail: Foundation Pour' });
    await expect(banner).toBeVisible();

    await banner.getByRole('button', { name: 'Close task detail' }).click();
    await expect(banner).toHaveCount(0);
  });
});

/**
 * Calendar v2 fidelity polish (issue 1230): sprint-boundary dots and the "Due"
 * legend entry. Reuses the same fixtures + a sprint whose window lands in the
 * anchored month.
 */
test.describe('Calendar v2 fidelity polish (issue 1230)', () => {
  const SPRINT = {
    id: 'cal-sprint-1',
    server_version: 1,
    short_id: '1',
    short_id_display: 'SP-1',
    name: 'Sprint 1',
    goal: '',
    notes: '',
    start_date: '2026-03-09',
    finish_date: '2026-03-20',
    state: 'ACTIVE',
    target_milestone: null,
    target_milestone_detail: null,
    capacity_points: null,
    wip_limit: null,
    committed_points: 20,
    committed_task_count: 5,
    completed_points: 8,
    completed_task_count: 2,
    completion_ratio_points: 0.4,
    completion_ratio_tasks: 0.4,
    activated_at: '2026-03-09T00:00:00Z',
    closed_at: null,
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-09T00:00:00Z',
  };

  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projectId: PROJECT_ID,
      projects: [{ id: PROJECT_ID, name: 'Calendar Project', start_date: '2026-03-01' }],
      tasks: FIXTURE_TASKS,
    });
    // Last-registered wins: override the empty sprints stub with one real sprint.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 1, next: null, previous: null, results: [SPRINT] }),
      }),
    );
    await page.goto(CALENDAR_URL);
    await expect(page.getByRole('group', { name: 'Calendar view mode' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('marks sprint start/finish days with boundary dots', async ({ page }) => {
    // Sprint 03-09 → 03-20; both boundary days fall in the March grid.
    await expect(page.getByLabel('Sprint boundary').first()).toBeVisible();
    await expect(page.getByLabel('Sprint boundary')).toHaveCount(2);
  });

  test('legend includes the Due and Sprint boundary entries', async ({ page }) => {
    await expect(page.getByText('Due', { exact: true })).toBeVisible();
    await expect(page.getByText('Sprint boundary', { exact: true })).toBeVisible();
  });

  test('a task chip carries the ", due" finish marker in its accessible name', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Foundation Pour, due' })).toBeVisible();
  });
});
