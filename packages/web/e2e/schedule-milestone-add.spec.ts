import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Milestone-add dialog E2E — clicking "+ Milestone" opens TaskFormModal in
 * milestone mode (issue #240 follow-up). Verifies the dialog exposes Name +
 * Date + Parent up front and posts is_milestone:true / duration:0 on submit,
 * replacing the prior insert-then-edit-name path that gave the user no way
 * to set the date or parent at create time.
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
  },
  {
    id: 't2', wbs_path: '1.1', name: 'Discovery & Design',
    early_start: '2026-10-05', early_finish: '2026-10-16',
    // Completed task → never critical (#1863).
    duration: 10, percent_complete: 100, is_critical: false, is_milestone: false,
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
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_API_PROJECTS.length,
        next: null,
        previous: null,
        results: FIXTURE_API_PROJECTS,
      }),
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
        task_count: 0, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [],
        critical_tasks: [], last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown', spi: null, tasks_late_count: 0,
        critical_task_count: 0, total_tasks: 0, complete_tasks: 0,
        next_milestone: null, team_utilization_pct: null, owner_name: null,
        start_date: '2026-01-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  // Endpoints fired only when TaskFormModal mounts (project detail, role,
  // resource pool, sprints, task history). All return harmless empty bodies
  // so the modal can render without bouncing through 401-recovery.
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: FIXTURE_PROJECT_ID,
        name: 'Alpha Platform Upgrade',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
        agile_features: false,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/members/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ user_id: 'self', role: 300 }]),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/sprints/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/project-resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/tasks/*/history/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

test.describe('Schedule "+ Milestone" dialog', () => {
  test.beforeEach(async ({ page }) => {
    // Catch-all fallback. Playwright runs routes in LIFO order — the last
    // registered handler matches first — so this is registered first and
    // any specific route registered later (in gotoSchedule, or per-test)
    // wins. Returning a harmless empty body for unmocked endpoints keeps a
    // single missing route from cascading through 401-recovery into the
    // SessionExpired banner, which would intercept all subsequent clicks.
    // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
    // being masked by a permissive 200-list body (the #1190 flake class).
    await setupCatchAll(page);

    // Default tasks handler: GET returns the fixture list; POST returns a
    // generic milestone response. Per-test handlers register a more specific
    // route after this so they can capture or modify the create payload.
    await page.route('**/api/v1/tasks/**', (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            count: FIXTURE_API_TASKS.length,
            next: null,
            previous: null,
            results: FIXTURE_API_TASKS,
          }),
        });
        return;
      }
      if (method === 'POST') {
        const body = route.request().postDataJSON() as Record<string, unknown> | null;
        route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'm-default',
            wbs_path: '1.99',
            name: (body?.name as string) ?? 'Default milestone',
            early_start: (body?.planned_start as string) ?? '2026-01-01',
            early_finish: (body?.planned_start as string) ?? '2026-01-01',
            duration: 0,
            percent_complete: 0,
            is_critical: false,
            is_milestone: Boolean(body?.is_milestone),
          }),
        });
        return;
      }
      // PATCH / DELETE / etc — keep the proxy off the dead backend.
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await gotoSchedule(page);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('clicking + Milestone opens TaskFormModal in milestone mode', async ({ page }) => {
    await page.getByRole('button', { name: 'Add new milestone (Cmd+M)' }).click();
    const dialog = page.getByRole('dialog', { name: 'New milestone' });
    await expect(dialog).toBeVisible();
    // Name + Date are present; Duration is suppressed for milestones.
    // The "Milestone name" label and "Date" relabel together imply milestone
    // mode without needing a brittle eyebrow assertion.
    await expect(dialog.getByLabel('Milestone name *')).toBeVisible();
    await expect(dialog.getByLabel('Date')).toBeVisible();
    await expect(dialog.getByLabel(/Duration/)).toHaveCount(0);
  });

  test('Esc closes the milestone dialog without creating anything', async ({ page }) => {
    let postCount = 0;
    await page.route('**/api/v1/tasks/', (route) => {
      if (route.request().method() === 'POST') {
        postCount += 1;
        route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'should-not-happen' }),
        });
        return;
      }
      route.continue();
    });
    await page.getByRole('button', { name: 'Add new milestone (Cmd+M)' }).click();
    await expect(page.getByRole('dialog', { name: 'New milestone' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'New milestone' })).toHaveCount(0);
    expect(postCount).toBe(0);
  });

  test('submitting the dialog posts is_milestone:true with the chosen date', async ({ page }) => {
    let createPayload: Record<string, unknown> | null = null;
    await page.route('**/api/v1/tasks/', (route) => {
      if (route.request().method() === 'POST') {
        createPayload = route.request().postDataJSON() as Record<string, unknown>;
        route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'm-new',
            wbs_path: '1.2',
            name: createPayload.name,
            early_start: createPayload.planned_start,
            early_finish: createPayload.planned_start,
            duration: 0,
            percent_complete: 0,
            is_critical: false,
            is_milestone: true,
          }),
        });
        return;
      }
      route.continue();
    });

    await page.getByRole('button', { name: 'Add new milestone (Cmd+M)' }).click();
    const dialog = page.getByRole('dialog', { name: 'New milestone' });
    await dialog.getByLabel('Milestone name *').fill('Phase 1 sign-off');
    await dialog.getByLabel('Date').fill('2026-11-14');
    await dialog.getByRole('button', { name: 'Create milestone' }).click();

    // Modal closes after a successful create.
    await expect(page.getByRole('dialog', { name: 'New milestone' })).toHaveCount(0);

    // Payload assertions — the user's date and milestone flag must round-trip.
    expect(createPayload).not.toBeNull();
    expect(createPayload!).toMatchObject({
      name: 'Phase 1 sign-off',
      duration: 0,
      is_milestone: true,
      planned_start: '2026-11-14',
    });
  });
});
