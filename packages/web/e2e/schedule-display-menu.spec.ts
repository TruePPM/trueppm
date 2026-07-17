import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Schedule "Display" menu — WBS/Owner column toggles + the Chart section
 * (dependency lines, on-bar task-name placement, progress pills) — #2097.
 *
 * The Chart toggles persist to localStorage (`trueppm.schedule.chartDisplay.v1`),
 * distinct from the data filters mirrored to the URL, and hiding a chart element
 * lights the trigger's active-count badge.
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_API_PROJECTS = [
  { id: FIXTURE_PROJECT_ID, name: 'Alpha Platform Upgrade', description: '', start_date: '2026-01-01', calendar: 'default' },
];

const FIXTURE_API_TASKS = [
  {
    id: 't1', wbs_path: '1', name: 'Alpha Platform Upgrade',
    early_start: '2026-10-05', early_finish: '2026-11-14',
    duration: 30, percent_complete: 40, is_critical: false, is_milestone: false,
    status: 'IN_PROGRESS', is_summary: false, parent_id: null,
  },
  {
    id: 't2', wbs_path: '1.1', name: 'Discovery & Design',
    early_start: '2026-10-05', early_finish: '2026-10-16',
    duration: 10, percent_complete: 100, is_critical: false, is_milestone: false,
    status: 'COMPLETE', is_summary: false, parent_id: null,
  },
];

async function gotoSchedule(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  await setupCatchAll(page);
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: FIXTURE_API_PROJECTS.length, next: null, previous: null, results: FIXTURE_API_PROJECTS }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: FIXTURE_PROJECT_ID, name: 'Alpha Platform Upgrade', description: '', start_date: '2026-01-01', calendar: 'default', estimation_mode: 'OPEN', agile_features: false, methodology: 'HYBRID', code: '', health: 'AUTO', visibility: 'WORKSPACE', timezone: '', default_view: 'SCHEDULE', lead: null, lead_detail: null, iteration_label: 'Sprint', is_archived: false, archived_at: null, archived_by: null, recalculated_at: null, is_sample: false, program_detail: null, server_version: 1 }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_count: 0, critical_path_count: 0, monte_carlo_p80: null, at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [], last_saved: null, recalculated_at: null }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: 0, complete_tasks: 0, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-01-01' }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: FIXTURE_API_TASKS.length, next: null, previous: null, results: FIXTURE_API_TASKS }) }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/ws/ticket/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'e2e-ticket', expires_in: 30 }) }),
  );
  await page.routeWebSocket('**/ws/v1/projects/**', () => {
    /* accept and hold open */
  });
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

test.describe('Schedule Display menu — columns + Chart section (#2097)', () => {
  test.beforeEach(async ({ page }) => {
    // Wide viewport so the "Display" trigger shows its label and the Grid task
    // list renders (Columns section only appears in Grid mode).
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoSchedule(page);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('exposes WBS + Owner column toggles and the Chart section controls', async ({ page }) => {
    await page.getByRole('button', { name: 'Display' }).click();
    const menu = page.getByRole('menu', { name: 'Display options' });
    await expect(menu).toBeVisible();

    // WBS + Owner columns are now toggleable (previously missing).
    await expect(menu.getByRole('menuitemcheckbox', { name: 'WBS' })).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Owner' })).toBeVisible();

    // Chart section: dep lines + progress checkboxes, task-name radio group.
    await expect(menu.getByText('Chart')).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Dependency lines' })).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Progress %' })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Next to bar' })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Aligned left' })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Hidden' })).toBeVisible();
  });

  test('hiding dependency lines persists to localStorage and lights the badge', async ({ page }) => {
    await page.getByRole('button', { name: 'Display' }).click();
    const menu = page.getByRole('menu', { name: 'Display options' });
    await menu.getByRole('menuitemcheckbox', { name: 'Dependency lines' }).click();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem('trueppm.schedule.chartDisplay.v1');
          return raw ? JSON.parse(raw).dependencyLinesVisible : null;
        }),
      )
      .toBe(false);

    // The trigger now advertises one active/hidden element in its accessible name.
    await expect(page.getByRole('button', { name: /Display, 1 active/i })).toBeVisible();
  });

  test('selecting "Aligned left" name placement persists', async ({ page }) => {
    await page.getByRole('button', { name: 'Display' }).click();
    const menu = page.getByRole('menu', { name: 'Display options' });
    const aligned = menu.getByRole('menuitemradio', { name: 'Aligned left' });
    await aligned.click();
    await expect(aligned).toHaveAttribute('aria-checked', 'true');

    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem('trueppm.schedule.chartDisplay.v1');
          return raw ? JSON.parse(raw).taskNamePlacement : null;
        }),
      )
      .toBe('left');
  });
});
