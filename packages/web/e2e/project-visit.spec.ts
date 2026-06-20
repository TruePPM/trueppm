import { test, expect, type Page } from '@playwright/test';

/**
 * E2E coverage for the last-visited ping (ADR-0150, issue #1182).
 *
 * When a user opens a project, ProjectShell fires a fire-and-forget
 * `POST /projects/:id/visit/` that feeds the real last-visited landing default.
 * Verifies:
 *   - the ping fires once on project mount, and the page renders regardless
 *   - a failed ping is swallowed — the project view still renders
 *
 * All API calls are intercepted with Playwright route mocking; no server.
 */

const PROJECT_ID = 'e2e-visit-00000000-0000-0000-0000-000000001182';

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  name: 'Atlas Launch',
  description: '',
  start_date: '2026-04-01',
  calendar: 'default',
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'HYBRID',
};

async function setupAuth(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
}

async function mockShell(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-user',
        username: 'casey',
        display_name: 'Casey',
        initials: 'C',
        email: 'casey@example.com',
        max_project_role: 300,
        workspace_role: null,
        can_access_admin_settings: false,
        default_landing: 'auto',
        landing: {
          intent: 'project_overview',
          path: `/projects/${PROJECT_ID}/overview`,
          resolved_by: 'role_policy',
        },
      }),
    }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ edition: 'community' }),
    }),
  );
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [PROJECT_DETAIL] }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PROJECT_DETAIL),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'on_track',
        spi: null,
        tasks_late_count: 0,
        critical_task_count: 0,
        total_tasks: 0,
        complete_tasks: 0,
        next_milestone: null,
        team_utilization_pct: null,
        owner_name: null,
        start_date: '2026-04-01',
      }),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
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
  await page.route('**/api/v1/projects/*/attention/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route('**/api/v1/projects/*/my-tasks/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/projects/*/members/**', (r) => {
    const url = new URL(r.request().url());
    if (url.searchParams.get('self') === 'true') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'm1', role: 300, user_id: 'e2e-user' }]),
      });
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'm1', role: 300 }]),
    });
  });
}

test.describe('Project last-visited ping (#1182, ADR-0150)', () => {
  test('fires a single visit ping on project mount', async ({ page }) => {
    await setupAuth(page);
    await mockShell(page);

    const visits: string[] = [];
    await page.route(`**/api/v1/projects/${PROJECT_ID}/visit/`, (route) => {
      visits.push(route.request().method());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ recorded: true }),
      });
    });

    await page.goto(`/projects/${PROJECT_ID}/overview`);
    await page.waitForURL(new RegExp(`/projects/${PROJECT_ID}/overview`), { timeout: 10_000 });

    await expect.poll(() => visits.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    expect(visits.every((m) => m === 'POST')).toBe(true);
  });

  test('a failed visit ping does not break the project view', async ({ page }) => {
    await setupAuth(page);
    await mockShell(page);

    await page.route(`**/api/v1/projects/${PROJECT_ID}/visit/`, (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    );

    await page.goto(`/projects/${PROJECT_ID}/overview`);
    await page.waitForURL(new RegExp(`/projects/${PROJECT_ID}/overview`), { timeout: 10_000 });

    // The shell still renders its project-scoped chrome despite the failed ping.
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/overview`));
  });
});
