import { test, expect, type Page } from '@playwright/test';

/**
 * E2E coverage for the redesigned TaskDetailDrawer (#962, "Direction B").
 *
 * The drawer groups the registry-driven sections (ADR-0050) into four tabs —
 * Details / Subtasks / Activity / Files. Details is active by default and
 * carries the schedule strip + a deferred-save Description field above its
 * registered sections. Within a tab the first section is expanded and the rest
 * start collapsed (ADR-0050 lazy-load, preserved tab-by-tab). The header shows
 * the WBS pill, readiness/CP chips, and an editable task-name input. A
 * Settings-style save bar appears while the Description is dirty.
 *
 * All API calls are intercepted with Playwright route mocking.
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_API_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Alpha Platform Upgrade',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
    estimation_mode: 'open',
  },
];

const FIXTURE_API_TASKS = [
  {
    id: 't1',
    wbs_path: '1',
    name: 'Discovery & Design',
    early_start: '2026-10-05',
    early_finish: '2026-10-16',
    duration: 10,
    percent_complete: 50,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    optimistic_duration: 7,
    most_likely_duration: 10,
    pessimistic_duration: 15,
    estimate_status: null,
    status: 'IN_PROGRESS',
    planned_start: null,
    assignments: [],
  },
  {
    id: 't2',
    wbs_path: '2',
    name: 'Backend Implementation',
    early_start: '2026-10-19',
    early_finish: '2026-10-30',
    duration: 10,
    percent_complete: 0,
    total_float: 0,
    is_critical: true,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    optimistic_duration: null,
    most_likely_duration: null,
    pessimistic_duration: null,
    estimate_status: null,
    status: 'NOT_STARTED',
    planned_start: null,
    assignments: [],
  },
];

const FIXTURE_HISTORY = {
  count: 1,
  next: null,
  previous: null,
  results: [
    {
      id: 1,
      history_date: '2026-04-25T10:00:00Z',
      history_type: '~',
      history_user: 'alice',
      diff: [{ field: 'duration', old: '8', new: '10' }],
    },
  ],
};

async function gotoSchedule(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_API_PROJECTS }),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 0,
        critical_path_count: 0,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
        at_risk_tasks: [],
        critical_tasks: [],
        last_saved: null,
        recalculated_at: null,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown',
        spi: null,
        tasks_late_count: 0,
        critical_task_count: 0,
        total_tasks: 0,
        complete_tasks: 0,
        next_milestone: null,
        team_utilization_pct: null,
        owner_name: null,
        start_date: '2026-01-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [] }),
    }),
  );
  await page.route('**/api/v1/tasks/**', (route) => {
    // A PATCH (Description / name save) echoes the first task back so the
    // mutation's success handler has a well-shaped single-task response.
    if (route.request().method() === 'PATCH') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FIXTURE_API_TASKS[0]),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_API_TASKS.length,
        next: null,
        previous: null,
        results: FIXTURE_API_TASKS,
      }),
    });
  });
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/task-resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/tasks/*/history/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_HISTORY),
    }),
  );
  await page.route('**/tasks/*/baseline/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ has_baseline: false }),
    }),
  );

  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

async function openDrawer(page: Page, taskName: string) {
  const grid = page.getByRole('grid', { name: 'Task list' });
  await expect(grid).toBeVisible({ timeout: 10_000 });
  await grid.getByText(taskName, { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(taskName) }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  return drawer;
}

test.describe('TaskDetailDrawer redesign — tabs', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('renders the four tabs with Details active by default', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    for (const name of ['Details', 'Subtasks', 'Activity', 'Files']) {
      await expect(drawer.getByRole('tab', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect(drawer.getByRole('tab', { name: 'Details' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('header renders WBS pill and an editable task-name input', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await expect(drawer.getByText('1', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('textbox', { name: 'Task name' })).toHaveValue(
      'Discovery & Design',
    );
  });

  test('Details tab shows the schedule strip and (open) Overview assignees', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    // Schedule strip cells (group per cell).
    for (const label of ['Start', 'Finish', 'Duration', 'Float']) {
      await expect(drawer.getByRole('group', { name: label })).toBeVisible();
    }
    await expect(drawer.getByText('10d', { exact: true })).toBeVisible();
    // Overview is the first Details section → expanded → Assignees visible.
    await expect(drawer.getByRole('region', { name: 'Assignees' })).toBeVisible();
  });

  test('critical task shows the CP marker in the schedule strip', async ({ page }) => {
    const drawer = await openDrawer(page, 'Backend Implementation');
    await expect(drawer.getByText('CP', { exact: true }).first()).toBeVisible();
    await expect(drawer.getByText(/On the critical path/i)).toBeVisible();
  });
});

test.describe('TaskDetailDrawer redesign — tab grouping', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('Dependencies + Estimates live under the Details tab', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await expect(drawer.getByRole('button', { name: 'Dependencies' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Estimates' })).toBeVisible();
  });

  test('Attachments + External links live under the Files tab', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    // Not present on the default Details tab.
    await expect(drawer.getByRole('button', { name: 'External links' })).toHaveCount(0);
    await drawer.getByRole('tab', { name: 'Files' }).click();
    await expect(drawer.getByRole('button', { name: 'Attachments' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'External links' })).toBeVisible();
  });

  test('Comments + Activity + History live under the Activity tab', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await expect(drawer.getByRole('button', { name: 'History' })).toHaveCount(0);
    await drawer.getByRole('tab', { name: 'Activity' }).click();
    await expect(drawer.getByRole('button', { name: 'Comments' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Activity' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'History' })).toBeVisible();
  });

  test('History section shows audit records when expanded', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('tab', { name: 'Activity' }).click();
    await drawer.getByRole('button', { name: 'History' }).click();
    await expect(drawer.getByText('alice')).toBeVisible({ timeout: 5_000 });
  });

  test('Overview is rendered inline (no accordion); secondary sections start collapsed', async ({
    page,
  }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    // Overview work-state is curated inline — there is no "Overview" accordion
    // button; its Assignees region is visible directly.
    await expect(drawer.getByRole('button', { name: 'Overview' })).toHaveCount(0);
    await expect(drawer.getByRole('region', { name: 'Assignees' })).toBeVisible();
    // Dependencies (a secondary Details section) starts collapsed.
    await expect(drawer.getByRole('button', { name: 'Dependencies' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

test.describe('TaskDetailDrawer redesign — Description save bar', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('typing in Description reveals the save bar; Discard reverts it', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    const description = drawer.getByRole('textbox', { name: 'Description' });
    await expect(description).toBeVisible();

    // No save bar while clean.
    await expect(drawer.getByText('You have unsaved changes')).toHaveCount(0);

    await description.fill('Validate Phase-2 scope with the steering committee.');
    await expect(drawer.getByText('You have unsaved changes')).toBeVisible();

    await drawer.getByRole('button', { name: 'Discard' }).click();
    await expect(description).toHaveValue('');
    await expect(drawer.getByText('You have unsaved changes')).toHaveCount(0);
  });

  test('Save changes button persists the edit and clears the bar', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    const description = drawer.getByRole('textbox', { name: 'Description' });
    await description.fill('A new description.');
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await expect(drawer.getByText('You have unsaved changes')).toHaveCount(0, { timeout: 5_000 });
  });
});

test.describe('TaskDetailDrawer redesign — chrome', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('Esc closes the drawer', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
  });

  test('clicking the close button closes the drawer', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: 'Close task detail' }).click();
    await expect(drawer).not.toBeVisible();
  });
});
