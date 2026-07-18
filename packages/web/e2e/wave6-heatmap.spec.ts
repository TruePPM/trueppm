import { test, expect } from './fixtures/coverage';

/**
 * Wave 6 — Resources/Team heatmap (issues #217 + #219, ADR-0042).
 *
 * Golden path: SCHEDULER user opens Heatmap sub-tab → KPI row and heatmap render.
 * Error / empty states: MEMBER role cannot see Team tab; empty resources shows CTA.
 * Drawer: clicking an over-allocated cell opens the task drill-down drawer.
 *
 * All API calls are intercepted via page.route() — no backend required.
 */

const PROJECT_ID = 'e2e-heatmap-00000000-0000-0000-0000-000000000006';
const EMPTY_PROJECT_ID = 'test-project-empty';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Heatmap Test Project',
  description: '',
  start_date: '2026-04-01',
  calendar: 'default',
  estimation_mode: 'open',
};

// 8-week window; Alice is over-allocated in W19 and W20 (util > 100).
const FIXTURE_HEATMAP = {
  weeks: [
    '2026-W17',
    '2026-W18',
    '2026-W19',
    '2026-W20',
    '2026-W21',
    '2026-W22',
    '2026-W23',
    '2026-W24',
  ],
  resources: [
    {
      id: 'res-alice',
      name: 'Alice Kim',
      initials: 'AK',
      job_role: 'Lead Engineer',
      color: '#3E8C6D',
      calendar_differs_from_project: false,
      util: [80, 95, 130, 120, 70, 60, 80, 100],
    },
  ],
};

const FIXTURE_SUMMARY = {
  avg_utilization_pct: 92,
  over_allocated_count: 1,
  over_allocated_weeks: 'W19–W20',
  under_utilized_count: 0,
  under_utilized_names: [],
  headcount: 1,
  contractor_count: 0,
};

// SCHEDULER = 2, MEMBER = 1
const MEMBER_SCHEDULER = [{ id: 'mem-sched', role: 200 }];
const MEMBER_MEMBER = [{ id: 'mem-member', role: 100 }];

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

type Page = import('@playwright/test').Page;

async function setup(page: Page, memberRows = MEMBER_SCHEDULER) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const pj = (results: unknown[]) =>
    JSON.stringify({ count: results.length, next: null, previous: null, results });

  // --- Standard shell routes ---
  // /auth/me/ drives RootRedirect's server-resolved landing (ADR-0129). Point it
  // at this project's overview so `goto('/')` lands on /projects/.../overview.
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-user',
        username: 'pm',
        display_name: 'PM',
        initials: 'PM',
        email: 'pm@example.com',
        max_project_role: 300,
        workspace_role: null,
        can_access_admin_settings: true,
        default_landing: 'auto',
        landing: {
          intent: 'project_overview',
          path: `/projects/${PROJECT_ID}/overview`,
          resolved_by: 'role_policy',
        },
      }),
    }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ edition: 'community' }),
    }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'on_track',
        spi: null,
        tasks_late_count: 0,
        critical_task_count: 0,
        total_tasks: 3,
        complete_tasks: 1,
        next_milestone: null,
        team_utilization_pct: 92,
        owner_name: null,
        start_date: '2026-04-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [] }),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 3,
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
  await page.route('**/api/v1/tasks/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/dependencies/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/risks/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/board-config/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ columns: [] }),
    }),
  );
  await page.route('**/api/v1/monte-carlo/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: 0, p50: null, p80: null, p95: null, buckets: [] }),
    }),
  );
  await page.route('**/api/v1/projects/*/resource-allocation/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        project_id: PROJECT_ID,
        window_start: '2026-01-01',
        window_end: '2026-06-01',
        resources: [],
      }),
    }),
  );

  // --- Members (RBAC) — controls Team tab visibility and permission gate ---
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(memberRows) }),
  );

  // --- Wave 6 heatmap endpoints ---
  await page.route(`**/api/v1/projects/${PROJECT_ID}/resources/heatmap/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_HEATMAP),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/resources/summary/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_SUMMARY),
    }),
  );

  // --- Empty project routes (for empty-state test) ---
  // Specific routes first so the standard wildcards (*) don't need order-awareness.
  await page.route(`**/api/v1/projects/${EMPTY_PROJECT_ID}/resources/heatmap/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ weeks: FIXTURE_HEATMAP.weeks, resources: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${EMPTY_PROJECT_ID}/resources/summary/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...FIXTURE_SUMMARY, over_allocated_count: 0, headcount: 0 }),
    }),
  );
  await page.route(`**/api/v1/projects/${EMPTY_PROJECT_ID}/members/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MEMBER_SCHEDULER),
    }),
  );
  // Standard wildcard mocks (presence, status-summary, tasks, etc.) already cover
  // all other EMPTY_PROJECT_ID endpoints — no catch-all needed.
}

// ---------------------------------------------------------------------------
// RBAC — Team tab visibility
// ---------------------------------------------------------------------------

test.describe('Team tab RBAC', () => {
  test('Team tab is hidden for MEMBER role', async ({ page }) => {
    await setup(page, MEMBER_MEMBER);
    await page.goto('/');
    await page.waitForURL(/\/projects\/.+\/overview/, { timeout: 10_000 });

    // With role=MEMBER, ViewTabs hides the Team link pessimistically.
    await expect(
      page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Team' }),
    ).toHaveCount(0);
  });

  test('Team tab is visible for SCHEDULER role', async ({ page }) => {
    await setup(page, MEMBER_SCHEDULER);
    await page.goto('/');
    await page.waitForURL(/\/projects\/.+\/overview/, { timeout: 10_000 });

    await expect(
      page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Team' }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Heatmap page — golden path
// ---------------------------------------------------------------------------

test.describe('Heatmap page', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/resources/heatmap`);
    // Wait for React hydration and heatmap data before each test.
    await expect(page.getByRole('grid', { name: 'Resource utilization heatmap' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('Heatmap sub-tab renders KPI row and grid', async ({ page }) => {
    // TeamView sub-navigation pills.
    const subNav = page.getByRole('navigation', { name: 'Team sub-view' });
    await expect(subNav.getByRole('link', { name: 'Roster' })).toBeVisible();
    await expect(subNav.getByRole('link', { name: 'Allocation' })).toBeVisible();
    await expect(subNav.getByRole('link', { name: 'Heatmap' })).toBeVisible();

    // KPI cards — exact: true avoids matching the toolbar "1 over-allocated" badge.
    await expect(page.getByText('Avg utilization', { exact: true })).toBeVisible();
    await expect(page.getByText('Over-allocated', { exact: true })).toBeVisible();
    await expect(page.getByText('Under-utilized', { exact: true })).toBeVisible();
    await expect(page.getByText('Headcount', { exact: true })).toBeVisible();
  });

  test('Heatmap grid is present with at least one over-allocated cell', async ({ page }) => {
    const grid = page.getByRole('grid', { name: 'Resource utilization heatmap' });
    await expect(grid.getByRole('gridcell').first()).toBeVisible();
  });

  test('Clicking an over-allocated cell opens the drawer', async ({ page }) => {
    const grid = page.getByRole('grid', { name: 'Resource utilization heatmap' });

    // The first gridcell wraps a HeatmapCell button — click it.
    await grid.getByRole('button').first().click();

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 4_000 });

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('Weeks window control changes the grid column count', async ({ page }) => {
    // Register the 4-week fixture BEFORE clicking so the re-fetch lands on it.
    // util must have the same length as weeks to avoid a runtime crash.
    const resource4w = { ...FIXTURE_HEATMAP.resources[0], util: [80, 95, 130, 120] };
    await page.route(`**/api/v1/projects/${PROJECT_ID}/resources/heatmap/**`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          weeks: ['2026-W17', '2026-W18', '2026-W19', '2026-W20'],
          resources: [resource4w],
        }),
      }),
    );

    const weekGroup = page.getByRole('group', { name: 'Week window' });
    await weekGroup.getByRole('button', { name: '4w' }).click();

    // Grid may briefly unmount while the query refetches — re-wait for it first.
    const grid = page.getByRole('grid', { name: 'Resource utilization heatmap' });
    await expect(grid).toBeVisible({ timeout: 6_000 });
    // 1 resource col + 4 week cols = 5 columnheaders.
    await expect(grid.getByRole('columnheader')).toHaveCount(5, { timeout: 6_000 });
  });

  test('Level loads slot renders nothing in OSS (no Enterprise teaser)', async ({
    page,
  }) => {
    // Adoption-first: the resources_heatmap.level_loads Enterprise slot has no
    // OSS override, so the page renders no "Level loads" control at all — not a
    // disabled teaser button (issue 1614).
    const btn = page.getByRole('button', { name: /Level loads/i });
    await expect(btn).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Empty / error states
// ---------------------------------------------------------------------------

test.describe('Empty states', () => {
  test('Shows empty state when no resources are on the project', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${EMPTY_PROJECT_ID}/resources/heatmap`);

    await expect(page.getByText(/No team members yet/i)).toBeVisible({ timeout: 8_000 });
  });
});
