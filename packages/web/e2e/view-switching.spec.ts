import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures';

/**
 * View-switching E2E flows — navigate between Schedule, Grid, and Board views.
 *
 * Extends the view-mode switching covered in schedule.spec.ts with:
 * - Board view navigation and column rendering
 * - Round-trip switching (Schedule → Grid → Board → Schedule)
 * - URL reflects the active view so deep links work
 * - Legacy `/wbs` and `/list` URLs redirect to `/grid` (issue #334, ADR-0053)
 *
 * These run against the production build with intercepted API routes.
 */

const FIXTURE_PROJECT_ID = 'e2e-view-00000000-0000-0000-0000-000000000002';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'View Switching Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'v1', wbs_path: '1', name: 'Phase 1',
    early_start: '2026-01-05', early_finish: '2026-01-16',
    duration: 10, percent_complete: 50, is_critical: false,
    is_milestone: false, status: 'IN_PROGRESS',
  },
  {
    id: 'v2', wbs_path: '1.1', name: 'Design',
    early_start: '2026-01-05', early_finish: '2026-01-09',
    duration: 5, percent_complete: 100, is_critical: false,
    is_milestone: false, status: 'COMPLETE',
  },
  {
    id: 'v3', wbs_path: '1.2', name: 'Build',
    early_start: '2026-01-12', early_finish: '2026-01-16',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: false, status: 'NOT_STARTED',
  },
];

async function setup(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  // 401-guard net for the global shell endpoints (notifications, edition, …) that
  // now activate once /auth/me/ resolves to a real user — registered FIRST so the
  // spec's specific routes below still win, and unmocked endpoints return an empty
  // list instead of a 404 that would destabilize the shell mid-interaction.
  await setupCatchAll(page);
  // /auth/me/ — the project-index redirect (ProjectIndexRedirect, ADR-0162) now
  // holds until this resolves, so it must be mocked. The neutral `unified` lens
  // keeps the index → Overview behavior this spec asserts.
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-user',
        username: 'e2euser',
        display_name: 'E2E User',
        initials: 'EU',
        email: 'e2e@example.com',
        max_project_role: 400,
        workspace_role: null,
        can_access_admin_settings: true,
        default_landing: 'my_work',
        landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
        hidden_views: [],
        role_context: 'unified',
      }),
    }),
  );
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: FIXTURE_PROJECTS.length, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  // Overview endpoints — stub with minimal data so ProjectOverviewPage doesn't error
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: 0, complete_tasks: 0, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-01-01' }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  // Blocked roll-up (ADR-0124) — the Overview page mounts useProjectBlocked; an
  // unmocked 401 here pops the session-expired modal and blocks navigation clicks.
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/blocked/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ project_id: FIXTURE_PROJECT_ID, count: 0, blocked: [] }),
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
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: FIXTURE_TASKS.length, next: null, previous: null, results: FIXTURE_TASKS }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  // Board batch 3 (#184) — Board view fires resource-allocation on mount.
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/resource-allocation/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        project_id: FIXTURE_PROJECT_ID,
        window_start: '2026-01-01',
        window_end: '2026-03-01',
        resources: [],
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/risks/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  // Board config — 5-column default (issue #178)
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-config/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        columns: [
          { status: 'BACKLOG',     label: 'Backlog',     visible: true },
          { status: 'NOT_STARTED', label: 'To Do',       visible: true },
          { status: 'IN_PROGRESS', label: 'In Progress', visible: true },
          { status: 'REVIEW',      label: 'Review',      visible: true },
          { status: 'COMPLETE',    label: 'Done',        visible: true },
        ],
      }),
    }),
  );
}

test.describe('View switching', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    // Start on Schedule — path-based routing (ADR-0030)
    await page.goto(`${BASE_URL}/schedule`);
    // Wait for the Schedule view to be ready before switching views.
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('Schedule tab is active when on /schedule URL and URL reflects it', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await expect(nav.getByRole('link', { name: 'Schedule' })).toHaveAttribute('aria-current', 'page');
    expect(page.url()).toMatch(/\/schedule$/);
  });

  test('navigate to Grid — Outline mode treegrid renders by default and URL updates', async ({ page }) => {
    // Grid replaces WBS + Table (issue #334, ADR-0053). HYBRID methodology
    // (the test fixture default) defaults to Outline mode.
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'Grid' }).click();
    await expect(page).toHaveURL(/\/grid$/);
    await expect(page.getByRole('treegrid', { name: 'Outline task tree' })).toBeVisible();
  });

  test('navigate to Board — columns render and URL updates', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'Board' }).click();
    await expect(page).toHaveURL(/\/board$/);
    // Board renders columns; at least the "To Do" column should be visible.
    await expect(page.locator('[aria-label*="To Do"]').first()).toBeVisible({ timeout: 5_000 });
  });

  test('Grid mode toggle switches between Outline and Flat without changing the URL', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });
    await nav.getByRole('link', { name: 'Grid' }).click();
    await expect(page).toHaveURL(/\/grid$/);
    // Switch to Flat — the segmented control labels each button with its
    // descriptive name (per UX spec § 9 accessibility).
    await page.getByRole('button', { name: 'Flat list' }).click();
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible();
    // URL is unchanged — modes are component state, not routes (ADR-0053 § 2).
    await expect(page).toHaveURL(/\/grid$/);
  });

  test('round-trip Schedule → Grid → Board → Schedule', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'View' });

    await nav.getByRole('link', { name: 'Grid' }).click();
    await expect(page.getByRole('treegrid', { name: 'Outline task tree' })).toBeVisible();

    await nav.getByRole('link', { name: 'Board' }).click();
    await expect(page.locator('[aria-label*="To Do"]').first()).toBeVisible({ timeout: 5_000 });

    await nav.getByRole('link', { name: 'Schedule' }).click();
    await expect(page).toHaveURL(/\/schedule$/);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible();
  });

  test('legacy /wbs URL redirects to /grid (issue #334 redirect)', async ({ page }) => {
    await page.goto(`${BASE_URL}/wbs`);
    await expect(page).toHaveURL(/\/grid$/, { timeout: 10_000 });
    await expect(page.getByRole('treegrid', { name: 'Outline task tree' })).toBeVisible();
  });

  test('legacy /list URL redirects to /grid (issue #334 redirect)', async ({ page }) => {
    await page.goto(`${BASE_URL}/list`);
    await expect(page).toHaveURL(/\/grid$/, { timeout: 10_000 });
  });

  test('navigating to /projects/:id with no view segment redirects to Overview (ADR-0030)', async ({ page }) => {
    // React Router index route: <Navigate to="overview" replace /> — must redirect immediately.
    await page.goto(BASE_URL);
    await expect(page).toHaveURL(/\/overview$/, { timeout: 5_000 });
    await expect(page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Overview' }))
      .toHaveAttribute('aria-current', 'page');
  });

  test('Overview leads the grouped view bar; Board is present in TRACK (ADR-0030/0128)', async ({ page }) => {
    // v2 groups the tabs into PLAN / TRACK / PEOPLE (ADR-0128). Overview stays the
    // standalone leading tab; Board moved into the TRACK group (no longer 2nd).
    const nav = page.getByRole('navigation', { name: 'View' });
    const links = nav.getByRole('link');
    await expect(links.nth(0)).toHaveText('Overview');
    await expect(nav.getByRole('link', { name: 'Board' })).toBeVisible();
  });
});
